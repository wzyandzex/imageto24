// @vitest-environment jsdom
//
// Component tests for the animated-GIF upload + routing UI (issue #16). #16
// wires the detection seam into the single-image flow: a multi-frame GIF shows
// its frame count + an honest "treated as a still for now" notice, a
// single-frame GIF shows neither, and the run forwards the `animated` routing
// flag to the worker so it dispatches to `processAnimated`.
//
// The detection function itself is exercised under Vitest with real bytes (see
// animatedDetect.test.ts); here we feed those same real GIF bytes through the
// public upload path so the test asserts the *wiring*, not the scanner.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

// Capture the worker call so we can assert the `animated` routing flag.
let processImageInWorkerImpl: (
  input: unknown,
  opts?: {
    onModelProgress?: (p: { phase: string; received?: number; total?: number }) => void;
    onDecodeProgress?: (p: { phase: string }) => void;
  },
) => Promise<{
  buffer: ArrayBuffer;
  meta: { mode: string; factor?: number; width: number; height: number; noUpscale: boolean };
}>;

vi.mock("@/pipeline/browser/runInWorker", () => ({
  // The DecodeProgress type import in App.tsx is type-only and erased, so the
  // runtime mock only needs the function.
  processImageInWorker: vi.fn(
    (
      input: unknown,
      opts?: {
        onModelProgress?: (p: { phase: string; received?: number; total?: number }) => void;
        onDecodeProgress?: (p: { phase: string }) => void;
      },
    ) => processImageInWorkerImpl(input, opts),
  ),
}));

// Mock the browser capability probe — generous "AI available" device. webCodecs
// defaults to absent so the degrade (GIF) path is the baseline; issue #29 tests
// flip it to exercise the APNG branch. Mirrors the worker's hasWebCodecs() gate.
const mockCapability: { webgpu: boolean; memBudget: number; webCodecs?: boolean } = {
  webgpu: true,
  memBudget: 8_000_000_000,
};
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";

/* -------------------------------------------------------------------------- */
/* Real GIF bytes — the detection function runs on these unmodified           */
/* -------------------------------------------------------------------------- */

/**
 * Append a Graphic Control Extension (4-byte sub-block shape).
 */
function gce(): number[] {
  return [
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
  ];
}

/**
 * Append an Image Descriptor for a 1×1 frame + minimal LZW image data.
 */
function imageDescriptor(): number[] {
  return [
    0x2c,
    0x00, 0x00, 0x00, 0x00, // left, top
    0x01, 0x00, 0x01, 0x00, // width, height
    0x00, // packed (no LCT)
    0x02, 0x01, 0x00, 0x00, // LZW min code size + sub-block + terminator
  ];
}

/** Build a real GIF89a with the given number of frames (mirrors the unit tests). */
function buildGif(frames: number): Uint8Array {
  const bytes: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD + packed (2-colour GCT)
    0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT
  ];
  for (let i = 0; i < frames; i++) {
    bytes.push(...gce());
    bytes.push(...imageDescriptor());
  }
  bytes.push(0x3b); // trailer
  return new Uint8Array(bytes);
}

/** ASCII codes for a RIFF/PNG four-cc. */
function fourcc(s: string): number[] {
  return s.split("").map((c) => c.charCodeAt(0));
}

/** 32-bit little-endian size prefix (RIFF). */
function le32(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** 32-bit big-endian size prefix (PNG). */
function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/**
 * Build an animated WebP (RIFF + WEBP + ANIM + N×ANMF chunks). Issue #26
 * routes multi-frame WebP to processAnimated, so the fixture carries real
 * ANMF frames (one per frame) — enough that detectAnimation reports
 * isAnimated + the frame count, like the GIF fixture does.
 */
function buildAnimatedWebp(frames = 2): Uint8Array {
  // ANIM chunk: the animation header (background colour + loop count). 6 bytes.
  const anim = [...fourcc("ANIM"), ...le32(6), 0, 0, 0, 0, 0, 0];
  // Each ANMF chunk is one frame: the real 16-byte frame header is
  // FrameX(3) + FrameY(3) + FrameWidthMinusOne(3) + FrameHeightMinusOne(3) +
  // FrameDuration(3) + Flags(1). The scan counts chunks by the declared size —
  // it never decodes pixels — but the size MUST match the byte count so the
  // walk lands on each next chunk correctly (else the stream desyncs).
  const anmf = () => [
    ...fourcc("ANMF"),
    ...le32(16),
    0, 0, 0, // FrameX (24-bit LE)
    0, 0, 0, // FrameY (24-bit LE)
    0, 0, 0, // FrameWidthMinusOne (24-bit LE)
    0, 0, 0, // FrameHeightMinusOne (24-bit LE)
    0x0a, 0x00, 0x00, // FrameDuration (24-bit LE, 100ms)
    0x00, // Flags
  ];
  const body = [...fourcc("WEBP"), ...anim];
  for (let i = 0; i < frames; i++) body.push(...anmf());
  return new Uint8Array([...fourcc("RIFF"), ...le32(body.length), ...body]);
}

/** CRC32 (IEEE) for PNG chunk checksums. */
function crc32(buf: Uint8Array): number {
  let table: number[] | undefined = (crc32 as unknown as { table?: number[] }).table;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { table?: number[] }).table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a PNG chunk: length(4 BE) + type(4) + data + crc(4). */
function pngChunk(type: string, data: number[]): number[] {
  const typeBuf = Array.from(Buffer.from(type, "ascii"));
  const crc = crc32(Uint8Array.from([...typeBuf, ...data]));
  return [...be32(data.length), ...typeBuf, ...data, ...be32(crc)];
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Build an APNG (PNG sig + IHDR + acTL). */
function buildApng(frames = 3): Uint8Array {
  const ihdr = pngChunk("IHDR", [
    0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
  const actl = pngChunk("acTL", [...be32(frames), 0x00, 0x00, 0x00, 0x00]);
  return new Uint8Array([...PNG_SIG, ...ihdr, ...actl]);
}

/* -------------------------------------------------------------------------- */
/* Render + upload helpers                                                     */
/* -------------------------------------------------------------------------- */

async function renderApp() {
  render(<App />);
  await screen.findByRole("heading", { name: "imageto24", level: 1 });
}

/**
 * Drive a file into the dropzone's single-file input. App reads dimensions from
 * an <img> off an object URL; jsdom can't decode a real image, so we stub Image
 * to fire onload synchronously with chosen dimensions (same pattern as the
 * resolution test). The file bytes are real — detectAnimation runs on them
 * unmocked, so the GIF / WebP / APNG scans exercise the real detection code.
 */
async function upload(
  bytes: Uint8Array,
  name: string,
  type: string,
  width = 640,
  height = 360,
) {
  const file = new File([bytes], name, { type });
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: ((ev: Event) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    set src(_url: string) {
      queueMicrotask(() => this.onload?.(new Event("load")));
    }
    get src() {
      return "";
    }
  }
  vi.stubGlobal("Image", FakeImage);
  try {
    const input = document.querySelector(
      'input[type="file"]:not([multiple])',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByTestId("original-dimensions")).toBeInTheDocument(),
    );
  } finally {
    vi.unstubAllGlobals();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCapability.webgpu = true;
  mockCapability.memBudget = 8_000_000_000;
  // jsdom's File lacks arrayBuffer(); polyfill so loadFile can read the bytes
  // and run detectAnimation on them (returning the real GIF bytes we built).
  if (typeof File.prototype.arrayBuffer !== "function") {
    File.prototype.arrayBuffer = function (this: File) {
      // Return the underlying bytes the File was constructed with. jsdom stores
      // them on the Blob's internal [[blobParts]]; reconstruct from the parts.
      return Promise.resolve(this.slice(0).arrayBuffer());
    };
  }
  // jsdom Blob.slice().arrayBuffer() may also be missing; back it with a
  // best-effort read of the blob parts.
  if (typeof Blob.prototype.arrayBuffer !== "function") {
    Blob.prototype.arrayBuffer = function (this: Blob) {
      // Read the text/bytes synchronously is not possible for arbitrary parts;
      // for our test GIFs the File is built from a single Uint8Array, which
      // jsdom exposes via slice(). We resolve to a copy of the buffer.
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(this);
      });
    };
  }
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
      "blob:mock";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
  // Default worker impl: a faithful 4K-style result.
  processImageInWorkerImpl = async () => ({
    buffer: new ArrayBuffer(8),
    meta: { mode: "faithful", factor: 4, width: 3840, height: 2160, noUpscale: false },
  });
});

describe("animated-GIF upload UI (issue #16)", () => {
  it("shows the frame count + 'animation preserved' notice for a multi-frame GIF", async () => {
    await renderApp();
    // A real 3-frame GIF: detectAnimation runs on the actual bytes.
    await upload(buildGif(3), "clip.gif", "image/gif");

    // Frame count surfaces (PRD story #17).
    const frameCount = screen.getByTestId("animated-frame-count");
    expect(frameCount.textContent).toMatch(/3 frames?/);
    // Honest "animation preserved" messaging (issue #18: processAnimated now
    // upscales every frame and re-encodes a playable GIF, replacing the old
    // "treated as a still for now" placeholder notice).
    expect(screen.getByTestId("animated-notice").textContent).toMatch(
      /animation is preserved/i,
    );
    // The animated-WebP / APNG notices must NOT show for a GIF.
    expect(screen.queryByTestId("animated-webp-notice")).toBeNull();
    expect(screen.queryByTestId("apng-notice")).toBeNull();
  });

  it("shows no animated notice for a single-frame GIF (it's a still)", async () => {
    await renderApp();
    await upload(buildGif(1), "clip.gif", "image/gif");

    // A single-frame GIF routes to processImage, not processAnimated — none of
    // the animated notices should render.
    expect(screen.queryByTestId("animated-gif-notice")).toBeNull();
    expect(screen.queryByTestId("animated-frame-count")).toBeNull();
    expect(screen.queryByTestId("animated-webp-notice")).toBeNull();
    expect(screen.queryByTestId("apng-notice")).toBeNull();
  });

  it("forwards the animated routing flag to the worker for a multi-frame GIF", async () => {
    // Capture the worker input on the run so we can assert the routing flag.
    let captured: { animated?: boolean; format?: string } | undefined;
    processImageInWorkerImpl = (input) => {
      captured = input as { animated?: boolean; format?: string };
      return Promise.resolve({
        buffer: new ArrayBuffer(8),
        meta: { mode: "faithful", factor: 4, width: 3840, height: 2160, noUpscale: false },
      });
    };

    await renderApp();
    await upload(buildGif(5), "clip.gif", "image/gif");

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(captured).toBeDefined());

    // The routing flag is set → the worker dispatches to processAnimated.
    expect(captured!.animated).toBe(true);
    expect(captured!.format).toBe("gif");
  });

  it("does not set the animated flag for a single-frame GIF run", async () => {
    let captured: { animated?: boolean } | undefined;
    processImageInWorkerImpl = (input) => {
      captured = input as { animated?: boolean };
      return Promise.resolve({
        buffer: new ArrayBuffer(8),
        meta: { mode: "faithful", factor: 4, width: 3840, height: 2160, noUpscale: false },
      });
    };

    await renderApp();
    await upload(buildGif(1), "clip.gif", "image/gif");

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(captured).toBeDefined());

    // A single-frame GIF stays on the still path — no animated flag.
    expect(captured!.animated).toBeFalsy();
  });

  it("runs the upscale to completion for an animated GIF (animated route, mocked result)", async () => {
    // The worker is mocked to return a fixed faithful result, so this asserts
    // the routing wiring settles to "done" with a usable result — the real
    // per-frame decode/encode is exercised end-to-end by the Playwright GIF
    // suite (and the orchestration contract by processAnimated.test.ts).
    await renderApp();
    await upload(buildGif(4), "clip.gif", "image/gif");

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("result-dimensions")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("result-dimensions").textContent).toMatch(
      /3840 × 2160/,
    );
  });
});

describe("animated WebP / APNG notices (issue #16/#26, PRD stories #19/#20)", () => {
  it("routes an animated WebP to the animated path and shows the frame-count notice (issue #26)", async () => {
    await renderApp();
    // A multi-frame WebP (RIFF + ANIM + ≥2 ANMF). Issue #26 routes animated
    // WebP to processAnimated, so the UI shows the animated notice with the
    // detected frame count — the same shape as a multi-frame GIF. It must NOT
    // show the v2 "treated as a still" notice (that was the pre-#26 behaviour).
    await upload(buildAnimatedWebp(2), "anim.webp", "image/webp");

    expect(screen.getByTestId("animated-notice")).toBeInTheDocument();
    expect(screen.getByTestId("animated-frame-count").textContent).toMatch(
      /2 frames/,
    );
    // The honest "treated as a still" notice no longer applies to a routed
    // animated WebP (kept only for detection-only fallback cases).
    expect(screen.queryByTestId("animated-webp-notice")).toBeNull();
    expect(screen.queryByTestId("apng-notice")).toBeNull();
  });

  it("routes an animated APNG to the animated path and shows the frame-count notice (issue #39)", async () => {
    await renderApp();
    await upload(buildApng(3), "anim.png", "image/png");

    expect(screen.getByTestId("animated-notice")).toBeInTheDocument();
    expect(screen.getByTestId("animated-notice").textContent).toMatch(/Animated PNG \(APNG\)/i);
    expect(screen.getByTestId("animated-frame-count").textContent).toMatch(/3 frames/);
    expect(screen.queryByTestId("apng-notice")).toBeNull();
  });

  it("shows the single-frame APNG still notice on upload", async () => {
    await renderApp();
    await upload(buildApng(1), "still.png", "image/png");

    expect(screen.getByTestId("apng-notice")).toBeInTheDocument();
    expect(screen.getByTestId("apng-notice").textContent).toMatch(/single frame|still image/i);
    expect(screen.queryByTestId("animated-notice")).toBeNull();
    expect(screen.queryByTestId("animated-webp-notice")).toBeNull();
  });

  it("sets the animated routing flag for an animated WebP (dispatches to processAnimated)", async () => {
    // Issue #26: a multi-frame WebP is now routed to processAnimated, like a
    // multi-frame GIF. The `animated` flag must therefore be set, so the worker
    // dispatches to processAnimated (which forwards format to the decoder).
    let captured: { animated?: boolean; format?: string } | undefined;
    processImageInWorkerImpl = (input) => {
      captured = input as { animated?: boolean; format?: string };
      return Promise.resolve({
        buffer: new ArrayBuffer(8),
        meta: {
          mode: "faithful",
          factor: 4,
          width: 3840,
          height: 2160,
          noUpscale: false,
          frameCount: 2,
        },
      });
    };

    await renderApp();
    await upload(buildAnimatedWebp(2), "anim.webp", "image/webp");

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(captured).toBeDefined());
    expect(captured!.animated).toBe(true);
    expect(captured!.format).toBe("webp");
  });

  it("sets the animated routing flag and APNG decoder format for an animated APNG", async () => {
    let captured: { animated?: boolean; format?: string } | undefined;
    processImageInWorkerImpl = (input) => {
      captured = input as { animated?: boolean; format?: string };
      return Promise.resolve({
        buffer: new ArrayBuffer(8),
        meta: {
          mode: "faithful",
          factor: 4,
          width: 3840,
          height: 2160,
          noUpscale: false,
          frameCount: 3,
        },
      });
    };

    await renderApp();
    await upload(buildApng(3), "anim.png", "image/png");

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(captured).toBeDefined());
    expect(captured!.animated).toBe(true);
    expect(captured!.format).toBe("apng");
  });
});

/* -------------------------------------------------------------------------- */
/* Animated output format — read-only, device-determined (issue #29)          */
/* -------------------------------------------------------------------------- */

describe("animated output format — read-only, device-determined (issue #29)", () => {
  it("shows the output format control as read-only for an animated GIF and states APNG on a WebCodecs device", async () => {
    // WebCodecs-capable device: animated output is true-colour APNG.
    mockCapability.webCodecs = true;

    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");

    // The read-only animated label is shown (not the PNG/WebP/JPEG cards).
    const label = screen.getByTestId("animated-output-label");
    expect(label.textContent).toMatch(/APNG/i);
    expect(label.textContent).toMatch(/true colour/i);
    // The still-path format buttons are not rendered for animated input.
    expect(screen.queryByTestId("output-format-png")).toBeNull();
    expect(screen.queryByTestId("output-format-webp")).toBeNull();
    expect(screen.queryByTestId("output-format-jpeg")).toBeNull();
  });

  it("states GIF (256 colours) + the WebCodecs reason on a non-WebCodecs device", async () => {
    // Non-WebCodecs device: honest degrade to 256-colour GIF.
    mockCapability.webCodecs = false;

    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");

    const label = screen.getByTestId("animated-output-label");
    expect(label.textContent).toMatch(/GIF/i);
    expect(label.textContent).toMatch(/256/i);
    expect(label.textContent).toMatch(/WebCodecs/i);
  });

  it("states APNG output for animated APNG even on a non-WebCodecs device", async () => {
    mockCapability.webCodecs = false;

    await renderApp();
    await upload(buildApng(3), "anim.png", "image/png");

    const label = screen.getByTestId("animated-output-label");
    expect(label.textContent).toMatch(/APNG/i);
    expect(label.textContent).toMatch(/true colour/i);
    expect(label.textContent).not.toMatch(/GIF/i);
  });

  it("the animation-preserved notice names the device-determined output (APNG vs GIF)", async () => {
    mockCapability.webCodecs = true;
    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");

    // The source-panel notice carries the format decision too (the
    // animated-output-format span).
    const fmt = screen.getByTestId("animated-output-format");
    expect(fmt.textContent).toMatch(/APNG/i);
  });

  it("keeps the format selector interactive for a still image (unchanged)", async () => {
    mockCapability.webCodecs = true;

    await renderApp();
    await upload(buildGif(1), "clip.gif", "image/gif");

    // A still image keeps the PNG/WebP/JPEG cards interactive; the read-only
    // animated label is NOT rendered.
    expect(screen.queryByTestId("animated-output-label")).toBeNull();
    expect(screen.getByTestId("output-format-png")).toBeInTheDocument();
    expect(screen.getByTestId("output-format-webp")).toBeInTheDocument();
    expect(screen.getByTestId("output-format-jpeg")).toBeInTheDocument();
  });
});

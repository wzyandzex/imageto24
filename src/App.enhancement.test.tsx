// @vitest-environment jsdom
//
// Enhancement-strength slider and preset UI tests (issues #40/#62, ADR-0008). These assert the
// acceptance criteria the pure tests can't reach: the slider appears only in AI
// mode for still images, defaults to 100%, is continuous (0–100), carries
// honest end-labels, exposes named presets, and is hidden in faithful mode and
// for local animated AI inputs.
//
// Mirrors the mocking pattern in App.animated.test.tsx: the worker and the
// browser capability probe are stubbed so the test runs in jsdom, and real GIF
// bytes drive detectAnimation so the animated-hide branch is exercised for real.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

let processImageInput: unknown;

vi.mock("@/pipeline/browser/runInWorker", () => ({
  processImageInWorker: vi.fn(async (input: unknown) => {
    processImageInput = input;
    return {
      buffer: new ArrayBuffer(8),
      meta: { mode: "ai", factor: 4, width: 3840, height: 2160, noUpscale: false },
    };
  }),
}));

// Mock the browser capability probe — generous "AI available" device.
const mockCapability = { webgpu: true, memBudget: 8_000_000_000 };
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";
import { processImageInWorker } from "@/pipeline/browser/runInWorker";

/* -------------------------------------------------------------------------- */
/* Real GIF bytes — detectAnimation runs on these unmodified (mirror of        */
/* App.animated.test.tsx so the animated-hide branch is real, not mocked).     */
/* -------------------------------------------------------------------------- */

/** Append a Graphic Control Extension (4-byte sub-block shape). */
function gce(): number[] {
  return [0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00];
}

/** Append an Image Descriptor for a 1×1 frame + minimal LZW image data. */
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

/* -------------------------------------------------------------------------- */
/* Render + upload helpers (mirror App.animated.test.tsx)                      */
/* -------------------------------------------------------------------------- */

async function renderApp() {
  render(<App />);
  await screen.findByRole("heading", { name: "imageto24", level: 1 });
}

/**
 * Drive a file into the dropzone's single-file input. jsdom can't decode a real
 * image, so Image is stubbed to fire onload synchronously with chosen dims
 * (same pattern as the resolution/animated tests). detectAnimation runs on the
 * real bytes unmocked.
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
    // After the first upload the dropzone unmounts and only the "Choose a
    // different image" replace input remains; querySelectorAll returns them in
    // document order, so the LAST one is always the currently-mounted input
    // (the dropzone when no source is loaded, the replace input once one is).
    const inputs = document.querySelectorAll(
      'input[type="file"]:not([multiple])',
    );
    const input = inputs[inputs.length - 1] as HTMLInputElement;
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
  processImageInput = undefined;
  if (typeof File.prototype.arrayBuffer !== "function") {
    File.prototype.arrayBuffer = function (this: File) {
      return Promise.resolve(this.slice(0).arrayBuffer());
    };
  }
  if (typeof Blob.prototype.arrayBuffer !== "function") {
    Blob.prototype.arrayBuffer = function (this: Blob) {
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
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () =>
      {};
  }
});

describe("enhancement-strength slider — visibility (issue #40, ADR-0008)", () => {
  it("is hidden in faithful mode (the default)", async () => {
    await renderApp();
    // Faithful is the default mode; the slider must not render.
    expect(screen.queryByTestId("enhancement-strength-control")).toBeNull();
  });

  it("appears in AI mode for a still image", async () => {
    await renderApp();
    // Switch to AI mode.
    fireEvent.click(screen.getByTestId("mode-ai"));
    expect(screen.getByTestId("enhancement-strength-control")).toBeInTheDocument();
  });

  it("appears in AI mode with no image loaded yet (configured once, run either)", async () => {
    // The settings block renders regardless of whether an image is loaded
    // (batch flow is independently configurable), so the slider should appear
    // in AI mode even before an upload.
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    expect(screen.getByTestId("enhancement-strength-control")).toBeInTheDocument();
  });

  it("disappears when switching back from AI to faithful", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    expect(screen.getByTestId("enhancement-strength-control")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("mode-faithful"));
    expect(screen.queryByTestId("enhancement-strength-control")).toBeNull();
  });

  it("is hidden in AI mode for an animated (multi-frame GIF) input, with the honest unavailable message", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    // Upload a real 3-frame GIF → detectAnimation reports isAnimated.
    await upload(buildGif(3), "clip.gif", "image/gif");
    // ADR-0008: blending the AI first frame against faithful subsequent frames
    // causes visible frame-to-frame inconsistency, so the slider is hidden for
    // animated inputs (#40). #41 surfaces the reason honestly rather than
    // silently omitting the control.
    expect(screen.queryByTestId("enhancement-strength-control")).toBeNull();
    const msg = screen.getByTestId("enhancement-strength-unavailable");
    expect(msg.textContent).toMatch(/available for still images only/i);
  });
});

describe("enhancement-strength slider — animated messaging (issue #41, ADR-0008)", () => {
  it("shows neither slider nor unavailable message in faithful mode with an animated input", async () => {
    // The unavailable message is AI-specific: faithful mode has no AI to blend,
    // so neither the slider nor the explanation should render for an animated GIF.
    await renderApp();
    await upload(buildGif(3), "clip.gif", "image/gif");
    expect(screen.queryByTestId("enhancement-strength-control")).toBeNull();
    expect(screen.queryByTestId("enhancement-strength-unavailable")).toBeNull();
  });

  it("shows the slider (not the message) for a still image in AI mode", async () => {
    // A single-frame GIF is a still (detectAnimation reports isAnimated=false),
    // so the slider must show and the unavailable message must not — the inverse
    // of the animated case. This covers the "load still → slider visible" AC
    // (issue #41) from the still direction, which is deterministic (no race
    // between a second upload and React's re-render).
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    await upload(buildGif(1), "still.gif", "image/gif");
    expect(screen.getByTestId("enhancement-strength-control")).toBeInTheDocument();
    expect(screen.queryByTestId("enhancement-strength-unavailable")).toBeNull();
  });

  it("the unavailable message explains why (frame-to-frame inconsistency)", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    await upload(buildGif(2), "clip.gif", "image/gif");
    const msg = screen.getByTestId("enhancement-strength-unavailable");
    // The reason is stated honestly, not just the headline — the user should
    // understand *why* the control is unavailable (ADR-0008).
    expect(msg.textContent).toMatch(/first frame/i);
    expect(msg.textContent).toMatch(/faithful/i);
  });
});

describe("enhancement presets — still-image AI (issue #62)", () => {
  it("renders Natural, Balanced, Crisp, and Full AI presets at their specified values", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));

    expect(screen.getByTestId("enhancement-preset-35").textContent).toMatch(/Natural.*35%/i);
    expect(screen.getByTestId("enhancement-preset-60").textContent).toMatch(/Balanced.*60%/i);
    expect(screen.getByTestId("enhancement-preset-80").textContent).toMatch(/Crisp.*80%/i);
    expect(screen.getByTestId("enhancement-preset-100").textContent).toMatch(/Full AI.*100%/i);
    expect(screen.getByTestId("enhancement-preset-100")).toHaveAttribute("aria-pressed", "true");
  });

  it("moves the slider when a preset is selected and still allows fine-tuning afterward", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));

    const slider = screen.getByTestId("enhancement-strength-slider") as HTMLInputElement;
    fireEvent.click(screen.getByTestId("enhancement-preset-60"));
    expect(slider.value).toBe("60");
    expect(screen.getByTestId("enhancement-strength-value").textContent).toMatch(/60%/);
    expect(screen.getByTestId("enhancement-preset-60")).toHaveAttribute("aria-pressed", "true");

    fireEvent.change(slider, { target: { value: "72" } });
    expect(slider.value).toBe("72");
    expect(screen.getByTestId("enhancement-strength-value").textContent).toMatch(/72%/);
    expect(screen.getByTestId("enhancement-preset-60")).toHaveAttribute("aria-pressed", "false");
  });

  it("passes the selected preset strength to the existing still-image alpha blend path", async () => {
    await renderApp();
    await upload(buildGif(1), "still.gif", "image/gif", 640, 360);
    fireEvent.click(screen.getByTestId("mode-ai"));
    fireEvent.click(screen.getByTestId("enhancement-preset-35"));

    fireEvent.click(screen.getByTestId("upscale-button"));
    await waitFor(() => expect(processImageInWorker).toHaveBeenCalled());

    expect(processImageInput).toMatchObject({
      animated: false,
      options: {
        mode: "ai",
        alpha: 0.35,
      },
    });
  });
});
describe("enhancement-strength slider — defaults + labels (issue #40)", () => {
  it("defaults to 100%", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    const slider = screen.getByTestId(
      "enhancement-strength-slider",
    ) as HTMLInputElement;
    expect(slider.value).toBe("100");
    expect(screen.getByTestId("enhancement-strength-value").textContent).toMatch(
      /100%/,
    );
  });

  it("is a continuous 0–100 range with no discrete steps beyond 1", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    const slider = screen.getByTestId(
      "enhancement-strength-slider",
    ) as HTMLInputElement;
    expect(slider.min).toBe("0");
    expect(slider.max).toBe("100");
    expect(slider.step).toBe("1");
  });

  it("states honest end-labels: 0% = no AI, 100% = full AI", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    const control = screen.getByTestId("enhancement-strength-control");
    expect(control.textContent).toMatch(/0%.*no AI.*faithful/i);
    expect(control.textContent).toMatch(/100%.*full AI/i);
  });

  it("updates the displayed value when the slider moves", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    const slider = screen.getByTestId(
      "enhancement-strength-slider",
    ) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "40" } });
    expect(slider.value).toBe("40");
    expect(screen.getByTestId("enhancement-strength-value").textContent).toMatch(
      /40%/,
    );
  });
});

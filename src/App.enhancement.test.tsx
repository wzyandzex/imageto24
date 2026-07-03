// @vitest-environment jsdom
//
// Enhancement-strength slider UI tests (issue #40, ADR-0008). These assert the
// acceptance criteria the pure tests can't reach: the slider appears only in AI
// mode for still images, defaults to 100%, is continuous (0–100), carries
// honest end-labels, and is hidden in faithful mode and for animated inputs.
//
// Mirrors the mocking pattern in App.animated.test.tsx: the worker and the
// browser capability probe are stubbed so the test runs in jsdom, and real GIF
// bytes drive detectAnimation so the animated-hide branch is exercised for real.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@/pipeline/browser/runInWorker", () => ({
  processImageInWorker: vi.fn(async () => ({
    buffer: new ArrayBuffer(8),
    meta: { mode: "ai", factor: 4, width: 3840, height: 2160, noUpscale: false },
  })),
}));

// Mock the browser capability probe — generous "AI available" device.
const mockCapability = { webgpu: true, memBudget: 8_000_000_000 };
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";

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

  it("is hidden in AI mode for an animated (multi-frame GIF) input", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("mode-ai"));
    // Upload a real 3-frame GIF → detectAnimation reports isAnimated.
    await upload(buildGif(3), "clip.gif", "image/gif");
    // ADR-0008: blending the AI first frame against faithful subsequent frames
    // causes visible frame-to-frame inconsistency, so the slider is hidden for
    // animated inputs. The messaging lands in #41; here we only assert it's gone.
    expect(screen.queryByTestId("enhancement-strength-control")).toBeNull();
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

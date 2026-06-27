// @vitest-environment jsdom
//
// Component tests for the resolution-control UI (issue #8). The three input
// modes (tier / explicit factor / custom long edge) are a UI concern above the
// pure `computeUpscaleFactor` seam — these tests assert the acceptance criteria
// the pure tests can't reach: the mode switcher renders the right control, the
// derived target follows the active mode, and the target-below-source boundary
// is surfaced in the UI rather than being a silent no-op.
//
// The worker and the browser capability probe are mocked so the test runs in
// jsdom without a real browser/GPU; we assert against the rendered controls and
// the boundary notice via their data-testids, mirroring `sanity.test.tsx`.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

// Mock the worker entry so App never spins up a real Web Worker. We only need
// processImageInWorker to exist as an importable symbol; these tests don't run
// it (no upscale is triggered — we assert pre-run UI state).
vi.mock("@/pipeline/browser/runInWorker", () => ({
  processImageInWorker: vi.fn(),
}));

// Mock the browser capability probe. The probed device capability is held in a
// module-level variable so individual tests can pin it (e.g. a small memory
// budget to exercise the AC #5 boundary). Defaults to a generous "AI available"
// device so the mode cards don't depend on the jsdom environment.
const mockCapability = {
  webgpu: true,
  memBudget: 8_000_000_000,
};
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

/** Override the probed capability for the next render (before renderApp). */
function setCapability(c: { webgpu: boolean; memBudget: number }) {
  mockCapability.webgpu = c.webgpu;
  mockCapability.memBudget = c.memBudget;
}

import App from "@/App";

/**
 * Upload-less render helper: App's controls render without a source (the shared
 * settings block is independent of an uploaded image), but the boundary notice
 * and resolution preview require a source. `withSource` injects one via the
 * private loadFile path by faking a file input — simpler to reach the state we
 * need by setting a source through the public dropzone input.
 */
async function renderApp() {
  render(<App />);
  // Flush the mount-time capability probe (a state update) before asserting.
  await screen.findByRole("heading", { name: "imageto24", level: 1 });
}

/**
 * Drive a synthetic PNG into the dropzone so the boundary-rule UI (which keys
 * off a loaded source) renders. App reads dimensions from an <img> loaded off an
 * object URL; jsdom never decodes a real image, so we stub the global Image
 * constructor to a fake whose src setter fires onload synchronously with our
 * chosen natural dimensions. We don't run the upscale — we only need App to
 * record the source.
 */
async function uploadSource(width = 640, height = 360) {
  const file = new File([new Uint8Array(8)], "source.png", { type: "image/png" });

  const RealImage = globalThis.Image;
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: ((ev: Event) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    set src(_url: string) {
      // Resolve onload on the next microtask so readDimensions's promise settles.
      queueMicrotask(() => {
        if (this.onload) this.onload(new Event("load"));
      });
    }
    get src() {
      return "";
    }
  }
  // jsdom's Image is a constructor on the global; replace it for this call.
  // (window.Image is the constructor readDimensions uses via `new Image()`.)
  vi.stubGlobal("Image", FakeImage);

  try {
    // The dropzone's single-file input is the first non-multiple file input.
    const input = document.querySelector(
      'input[type="file"]:not([multiple])',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    // Let the async loadFile (arrayBuffer + dimension read) settle.
    await screen.findByTestId("original-dimensions", {}, { timeout: 2000 });
  } finally {
    vi.unstubAllGlobals();
    void RealImage;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the mocked capability to the default generous device between tests.
  mockCapability.webgpu = true;
  mockCapability.memBudget = 8_000_000_000;
  // jsdom's File lacks `arrayBuffer()` and URL lacks `createObjectURL` in this
  // version; App.loadFile awaits file.arrayBuffer() and calls
  // URL.createObjectURL before reading dimensions. We only need loadFile to
  // proceed past them to the dimension read (the worker itself is mocked), so
  // polyfill minimal stubs.
  if (typeof File.prototype.arrayBuffer !== "function") {
    File.prototype.arrayBuffer = function (this: File) {
      return Promise.resolve(new ArrayBuffer(8));
    };
  }
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
      "blob:mock";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
});

describe("resolution control — mode switcher (issue #8)", () => {
  it("renders the three input modes with tier selected by default", async () => {
    await renderApp();
    expect(screen.getByTestId("res-mode-tier")).toBeInTheDocument();
    expect(screen.getByTestId("res-mode-factor")).toBeInTheDocument();
    expect(screen.getByTestId("res-mode-custom")).toBeInTheDocument();
    // Tier panel is the default; the tier buttons are present.
    expect(screen.getByTestId("resolution-tier-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("resolution-factor-panel")).toBeNull();
    expect(screen.queryByTestId("resolution-custom-panel")).toBeNull();
  });

  it("switching to factor mode shows the factor buttons", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("res-mode-factor"));
    expect(screen.getByTestId("resolution-factor-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("resolution-tier-panel")).toBeNull();
    expect(screen.getByTestId("factor-2")).toBeInTheDocument();
    expect(screen.getByTestId("factor-3")).toBeInTheDocument();
    expect(screen.getByTestId("factor-4")).toBeInTheDocument();
  });

  it("switching to custom mode shows the long-edge input", async () => {
    await renderApp();
    fireEvent.click(screen.getByTestId("res-mode-custom"));
    expect(screen.getByTestId("resolution-custom-panel")).toBeInTheDocument();
    expect(screen.getByTestId("custom-longedge-input")).toBeInTheDocument();
    expect(screen.queryByTestId("resolution-tier-panel")).toBeNull();
  });

  it("keeps the tier selector usable after switching modes (no value loss)", async () => {
    await renderApp();
    // Switch away and back; the 2K tier is still selectable.
    fireEvent.click(screen.getByTestId("res-mode-factor"));
    fireEvent.click(screen.getByTestId("res-mode-tier"));
    fireEvent.click(screen.getByTestId("tier-2K"));
    const tierPanel = screen.getByTestId("resolution-tier-panel");
    const selected2k = within(tierPanel).getByTestId("tier-2K");
    expect(selected2k.className).toContain("bg-primary");
  });
});

describe("resolution control — boundary notice (issue #8, AC #4)", () => {
  it("shows the no-op notice when a custom target is not larger than the source", async () => {
    await renderApp();
    // 640-long-edge source; ask for 640px custom → not larger.
    await uploadSource(640, 360);
    fireEvent.click(screen.getByTestId("res-mode-custom"));
    fireEvent.change(screen.getByTestId("custom-longedge-input"), {
      target: { value: "640" },
    });

    // The boundary notice renders and the resolution preview explains no upscale.
    expect(screen.getByTestId("boundary-noop")).toBeInTheDocument();
    expect(screen.getByTestId("resolution-preview").textContent).toMatch(/no upscale/i);
    // The trigger is disabled and explains why — never a silent no-op.
    expect(screen.getByTestId("upscale-button")).toBeDisabled();
    expect(screen.getByTestId("upscale-button").textContent).toMatch(/not larger/i);
  });

  it("shows no notice (and enables the trigger) for a larger custom target", async () => {
    await renderApp();
    await uploadSource(640, 360);
    fireEvent.click(screen.getByTestId("res-mode-custom"));
    fireEvent.change(screen.getByTestId("custom-longedge-input"), {
      target: { value: "3000" },
    });

    expect(screen.queryByTestId("boundary-noop")).toBeNull();
    expect(screen.getByTestId("resolution-preview").textContent).toMatch(/upscale at/i);
    expect(screen.getByTestId("upscale-button")).not.toBeDisabled();
  });
});

describe("resolution control — memory-budget boundary (issue #8, AC #5)", () => {
  // A 640×360 source upscaled at 4× needs (640*360 + 2560*1440)*4 ≈ 15MB of AI
  // memory (estimateAiMemoryCost). A device with a 1KB budget cannot fit any of
  // the factor/custom targets below, so AI must be refused with the memory
  // reason and faithful offered as the safe alternative — across every mode.
  const TINY_BUDGET = 1024;

  it("refuses AI with a memory reason when a large explicit factor blows the budget", async () => {
    setCapability({ webgpu: true, memBudget: TINY_BUDGET });
    await renderApp();
    await uploadSource(640, 360);
    fireEvent.click(screen.getByTestId("res-mode-factor"));
    fireEvent.click(screen.getByTestId("factor-4"));

    const aiCard = screen.getByTestId("mode-ai");
    expect(aiCard).toHaveAttribute("aria-disabled", "true");
    // The honest reason cites memory and offers faithful as the safe path.
    expect(aiCard.textContent).toMatch(/memory/i);
    expect(aiCard.textContent).toMatch(/faithful/i);
  });

  it("refuses AI with a memory reason when a large custom long edge blows the budget", async () => {
    setCapability({ webgpu: true, memBudget: TINY_BUDGET });
    await renderApp();
    await uploadSource(640, 360);
    fireEvent.click(screen.getByTestId("res-mode-custom"));
    fireEvent.change(screen.getByTestId("custom-longedge-input"), {
      target: { value: "3840" },
    });

    const aiCard = screen.getByTestId("mode-ai");
    expect(aiCard).toHaveAttribute("aria-disabled", "true");
    expect(aiCard.textContent).toMatch(/memory/i);
  });

  it("refuses AI with a memory reason when a tier blows the budget", async () => {
    setCapability({ webgpu: true, memBudget: TINY_BUDGET });
    await renderApp();
    await uploadSource(640, 360);
    fireEvent.click(screen.getByTestId("tier-4K"));

    const aiCard = screen.getByTestId("mode-ai");
    expect(aiCard).toHaveAttribute("aria-disabled", "true");
    expect(aiCard.textContent).toMatch(/memory/i);
  });
});

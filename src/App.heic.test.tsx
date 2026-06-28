// @vitest-environment jsdom
//
// Component tests for the single-image HEIC flow (issue #17, the HEIC tracer
// bullet). #15 wired the decoder seam; #17 wires the main-image UI path the
// seam left dangling: HEIC can't be read by `new Image()`, so the upload must
// not crash on the dimension probe, the preview must swap in a placeholder
// instead of a broken <img>, and the one-time heic2any load needs an honest
// indicator (PRD HEIC user story #5).
//
// These run in jsdom with the worker and capability probe mocked (mirroring
// App.resolution.test.tsx). We assert against data-testids so the tests stay
// glued to the user-facing surface, not the implementation.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

// Mock the worker entry. The default impl is overridden per-test via
// `setProcessImageInWorker`; tests either assert pre-run UI state (no run) or
// capture the opts callbacks to drive them manually.
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

// Mock the browser capability probe — a generous "AI available" device so the
// mode cards don't depend on the jsdom environment.
const mockCapability = { webgpu: true, memBudget: 8_000_000_000 };
vi.mock("@/pipeline/browser/capability", () => ({
  browserCapabilityDetector: {
    checkDeviceCapability: vi.fn(async () => ({ ...mockCapability })),
  },
}));

import App from "@/App";

/** Render App and flush the mount-time capability probe. */
async function renderApp() {
  render(<App />);
  await screen.findByRole("heading", { name: "imageto24", level: 1 });
}

/**
 * Drive a synthetic HEIC into the dropzone's single-file input. App's HEIC path
 * skips the <img> dimension probe (the browser can't decode HEIC), so — unlike
 * the PNG helper in App.resolution.test.tsx — no Image stub is needed. jsdom's
 * File lacks arrayBuffer(), so it's polyfilled in beforeEach.
 */
async function uploadHeic(name = "iphone.heic", type = "image/heic") {
  const file = new File([new Uint8Array(16)], name, { type });
  const input = document.querySelector(
    'input[type="file"]:not([multiple])',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  // Let loadFile (arrayBuffer + state set) settle.
  await waitFor(() =>
    expect(screen.getByTestId("heic-source-placeholder")).toBeInTheDocument(),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCapability.webgpu = true;
  mockCapability.memBudget = 8_000_000_000;
  // jsdom File/URL gaps App.loadFile depends on (it awaits file.arrayBuffer()
  // before the HEIC branch). Only the bytes are needed; the worker is mocked.
  if (typeof File.prototype.arrayBuffer !== "function") {
    File.prototype.arrayBuffer = function (this: File) {
      return Promise.resolve(new ArrayBuffer(16));
    };
  }
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: () => string }).createObjectURL = () =>
      "blob:mock";
  }
  if (typeof URL.revokeObjectURL !== "function") {
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  }
  // Default worker impl: a faithful-mode 4K-style result. Tests that need to
  // drive the decode-progress callback override this.
  processImageInWorkerImpl = async () => ({
    buffer: new ArrayBuffer(8),
    meta: { mode: "faithful", factor: 4, width: 3840, height: 2160, noUpscale: false },
  });
});

describe("single-image HEIC upload (issue #17)", () => {
  it("accepts a HEIC without crashing and shows the placeholder, not a broken preview", async () => {
    await renderApp();
    await uploadHeic();

    // No error surfaces — the old code crashed on `new Image()` here.
    expect(screen.queryByTestId("error")).toBeNull();
    // The placeholder renders in place of the un-decodable <img>.
    expect(screen.getByTestId("heic-source-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("source-preview")).toBeNull();
    // The dimensions line states they're read after conversion.
    expect(screen.getByTestId("original-dimensions").textContent).toMatch(
      /read after conversion|HEIC/i,
    );
  });

  it("accepts HEIC by extension when the MIME is application/octet-stream (iOS Safari)", async () => {
    // iOS Safari reports HEIC with an inconsistent MIME; formatFromFile falls
    // back to the .heic extension. Drive the upload with that MIME to confirm
    // the single-image path still lands on the HEIC branch.
    await renderApp();
    await uploadHeic("photo.heic", "application/octet-stream");

    expect(screen.queryByTestId("error")).toBeNull();
    expect(screen.getByTestId("heic-source-placeholder")).toBeInTheDocument();
  });

  it("does not disable the trigger for a HEIC at 4K (dims deferred to decode)", async () => {
    await renderApp();
    await uploadHeic();
    // 4K tier is the default. A 0×0 deferred source must not trip the boundary
    // rule and disable the run — the orchestrator computes the real factor.
    expect(screen.getByTestId("upscale-button")).not.toBeDisabled();
  });

  it("surfaces a clear error (not a crash) when the HEIC convert fails (PRD story #7)", async () => {
    // A malformed/unconvertible HEIC makes heic2any reject inside the worker;
    // the decoder wraps it with an honest message (see canvasCodec.ts). Here we
    // stub the worker to reject with that wrapped message and assert the UI
    // shows it as an error rather than crashing or hanging.
    processImageInWorkerImpl = async () => {
      throw new Error(
        "This HEIC file could not be converted. It may be corrupted or an " +
          "unsupported HEIC variant. Try a different file.",
      );
    };
    await renderApp();
    await uploadHeic("broken.heic");

    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });

    // The honest error surfaces; the page did not crash (no thrown promise
    // unhandled, the error testid is populated with a readable message).
    await waitFor(() =>
      expect(screen.getByTestId("error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("error").textContent).toMatch(/could not be converted/i);
    // The HEIC notice is gone once the run settles in error.
    expect(screen.queryByTestId("heic-converting-notice")).toBeNull();
  });
});

describe("HEIC first-use converter indicator (issue #17, PRD story #5)", () => {
  it("shows the converting notice when the worker reports heic-converting, then clears on result", async () => {
    // Capture the opts the worker call received so we can fire the
    // decode-progress callback, and hold the run open via a manual resolver so
    // the notice is observable before the run settles.
    let captured:
      | { onDecodeProgress?: (p: { phase: string }) => void }
      | undefined;
    type RunResult = Awaited<ReturnType<typeof processImageInWorkerImpl>>;
    let resolveRun: ((r: RunResult) => void) | undefined;
    processImageInWorkerImpl = (_input, opts) => {
      captured = opts;
      return new Promise<RunResult>((resolve) => {
        resolveRun = resolve;
      });
    };

    await renderApp();
    await uploadHeic();

    // No notice before the run.
    expect(screen.queryByTestId("heic-converting-notice")).toBeNull();

    // Trigger the run; the worker mock captured the callbacks but stays pending.
    await act(async () => {
      fireEvent.click(screen.getByTestId("upscale-button"));
    });
    await waitFor(() => expect(captured).toBeDefined());

    // Fire the HEIC-converting decode progress — the notice must appear.
    await act(async () => {
      captured!.onDecodeProgress?.({ phase: "heic-converting" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("heic-converting-notice")).toBeInTheDocument(),
    );
    // The generic processing copy is suppressed while the HEIC notice shows.
    expect(screen.queryByTestId("progress")).toBeNull();

    // Now settle the run; the notice clears and the result appears.
    await act(async () => {
      resolveRun!({
        buffer: new ArrayBuffer(8),
        meta: {
          mode: "faithful",
          factor: 4,
          width: 3840,
          height: 2160,
          noUpscale: false,
        },
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("result-dimensions")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("heic-converting-notice")).toBeNull();
    expect(screen.queryByTestId("progress")).toBeNull();
  });

  it("shows the generic processing copy while a non-HEIC (or pre-decode) run is in flight", async () => {
    // Sanity guard: the HEIC branch must not steal the generic message when no
    // decode progress has fired. Drive a PNG so no decode-progress arrives.
    processImageInWorkerImpl = () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              buffer: new ArrayBuffer(8),
              meta: {
                mode: "faithful",
                factor: 2,
                width: 1280,
                height: 720,
                noUpscale: false,
              },
            }),
          0,
        ),
      );

    await renderApp();
    // Upload a PNG via the same single-file input; stub Image so readDimensions
    // resolves (jsdom can't decode a real image).
    const file = new File([new Uint8Array(8)], "source.png", { type: "image/png" });
    class FakeImage {
      naturalWidth = 640;
      naturalHeight = 360;
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
      await act(async () => {
        fireEvent.change(input, { target: { files: [file] } });
      });
      await screen.findByTestId("original-dimensions");

      await act(async () => {
        fireEvent.click(screen.getByTestId("upscale-button"));
      });

      // Generic copy shows; the HEIC notice never appears for a PNG.
      await waitFor(() =>
        expect(screen.getByTestId("progress")).toBeInTheDocument(),
      );
      expect(screen.queryByTestId("heic-converting-notice")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

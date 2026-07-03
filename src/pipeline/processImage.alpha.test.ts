// @vitest-environment node
//
// Enhancement-strength wiring tests (issue #40, ADR-0008). The orchestrator
// picks which AI-side upscaler to call based on `alpha`: at α = 1 (the default)
// it calls `aiUpscaler` directly (skipping the redundant faithful pass); at
// α < 1 it calls `blendingUpscaler`, which composes the two. These tests stub
// all three upscalers and assert the dispatch — they do not assert blend math
// (covered by blendAlpha.test.ts) or pixel quality.
import { describe, expect, it, vi } from "vitest";
import { processImage } from "./processImage";
import type {
  AiModel,
  ContentType,
  ImageData,
  ImageFormat,
  PipelineDeps,
} from "./types";

/** A flat-colour ImageData of the given size. */
function imageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100;
    data[i + 1] = 110;
    data[i + 2] = 120;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Scale an ImageData's dimensions by an integer factor (a stand-in upscale). */
function scaleUp(src: ImageData, factor: number): ImageData {
  return imageData(src.width * factor, src.height * factor);
}

interface CallLog {
  ai: { factor?: number; alpha?: number; exactTargetSize?: { width: number; height: number } }[];
  faithful: { factor?: number; exactTargetSize?: { width: number; height: number } }[];
  blending: { factor?: number; alpha?: number; exactTargetSize?: { width: number; height: number } }[];
}

/**
 * Build a fully-stubbed PipelineDeps (AI-capable) with all three upscalers as
 * vi.fn, plus a call log so each test can assert which path ran. The blending
 * stub mirrors the real adapter's contract (factor + model + alpha + target).
 */
function makeDeps(): { deps: PipelineDeps; log: CallLog } {
  const log: CallLog = { ai: [], faithful: [], blending: [] };
  const src = imageData(640, 360);

  const deps: PipelineDeps = {
    decoder: {
      decode: vi.fn(async () => src),
    },
    encoder: {
      encode: vi.fn(async (image: ImageData) => {
        const buf = new ArrayBuffer(8);
        new DataView(buf).setUint32(0, image.width);
        new DataView(buf).setUint32(4, image.height);
        return buf;
      }),
    },
    faithfulUpscaler: {
      upscale: vi.fn(async (image: ImageData, o: { factor: number }) => {
        log.faithful.push(o);
        return scaleUp(image, o.factor);
      }),
    },
    aiUpscaler: {
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { factor: number; alpha?: number },
        ) => {
          log.ai.push(o);
          return scaleUp(image, o.factor);
        },
      ),
    },
    blendingUpscaler: {
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { factor: number; alpha: number; exactTargetSize?: { width: number; height: number } },
        ) => {
          log.blending.push(o);
          return scaleUp(image, o.factor);
        },
      ),
    },
    modelLoader: {
      loadModel: vi.fn(async (content: ContentType) => {
        const model: AiModel = { id: `stub-${content}`, content, nativeFactor: 4 };
        return model;
      }),
    },
    capability: {
      checkDeviceCapability: vi.fn(async () => ({
        webgpu: true,
        memBudget: 4_000_000_000,
      })),
    },
  };
  return { deps, log };
}

const baseOptions = {
  target: { tier: "4K" as const },
  outputFormat: "png" as const,
  lossless: true,
  preserveExif: true,
  contentType: "photo" as ContentType,
};

describe("processImage — enhancement strength dispatch (ADR-0008, issue #40)", () => {
  it("calls aiUpscaler directly at alpha = 1 (default), skipping the blend", async () => {
    const { deps, log } = makeDeps();

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" as ImageFormat },
      { mode: "ai", ...baseOptions },
    );

    // Default (no alpha) ⇒ α treated as 1 ⇒ direct AI, no blending.
    expect(log.ai).toHaveLength(1);
    expect(log.blending).toHaveLength(0);
    // The faithful upscaler is NOT called directly by the orchestrator in AI
    // mode at α = 1 (the blend, which would have called it, is skipped).
    expect(log.faithful).toHaveLength(0);
  });

  it("calls aiUpscaler directly when alpha is explicitly 1", async () => {
    const { deps, log } = makeDeps();

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" as ImageFormat },
      { mode: "ai", ...baseOptions, alpha: 1 },
    );

    expect(log.ai).toHaveLength(1);
    expect(log.blending).toHaveLength(0);
  });

  it("calls blendingUpscaler when alpha < 1 (e.g. 0.5)", async () => {
    const { deps, log } = makeDeps();

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" as ImageFormat },
      { mode: "ai", ...baseOptions, alpha: 0.5 },
    );

    // α < 1 ⇒ the blending upscaler runs; the orchestrator does NOT call
    // aiUpscaler directly (the blend owns both inner calls).
    expect(log.blending).toHaveLength(1);
    expect(log.blending[0].alpha).toBe(0.5);
    expect(log.ai).toHaveLength(0);
  });

  it("calls blendingUpscaler at alpha = 0 (collapses to faithful, but via the blend)", async () => {
    const { deps, log } = makeDeps();

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" as ImageFormat },
      { mode: "ai", ...baseOptions, alpha: 0 },
    );

    // α = 0 is still < 1, so the blend path runs (the blend itself collapses to
    // faithful output — that's blendAlpha's contract, tested separately).
    expect(log.blending).toHaveLength(1);
    expect(log.blending[0].alpha).toBe(0);
    expect(log.ai).toHaveLength(0);
  });

  it("forwards alpha, factor, and model to the blending upscaler", async () => {
    const { deps, log } = makeDeps();

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" as ImageFormat },
      { mode: "ai", ...baseOptions, alpha: 0.3 },
    );

    expect(log.blending).toHaveLength(1);
    expect(log.blending[0].alpha).toBe(0.3);
    // The factor resolves against the 4K tier for a 640×360 source (4×).
    expect(log.blending[0].factor).toBe(4);
  });

  it("never invokes enhancement strength in faithful mode (alpha is ignored)", async () => {
    const { deps, log } = makeDeps();

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" as ImageFormat },
      { mode: "faithful", ...baseOptions, alpha: 0.5 },
    );

    // Faithful mode never touches AI or blending regardless of alpha.
    expect(log.faithful).toHaveLength(1);
    expect(log.ai).toHaveLength(0);
    expect(log.blending).toHaveLength(0);
  });
});

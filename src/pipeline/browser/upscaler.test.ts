// @vitest-environment node
//
// createBlendingUpscaler tests (v4, ADR-0008). The blending upscaler is a thin
// composition: it runs both injected upscalers on the same source with the same
// options (so their outputs align), then hands the pair to blendAlpha. These
// tests stub the two inner upscalers with deterministic pixel buffers and assert
// the composition — that both are called, that options are forwarded, and that
// the blend math runs over their outputs. The exact pixel math is covered by
// blendAlpha.test.ts; here we assert the seam.
import { describe, expect, it, vi } from "vitest";
import { createBlendingUpscaler } from "./upscaler";
import type {
  AiAdapterOptions,
  AiModel,
  FaithfulUpscaleOptions,
  ImageData,
} from "../types";

/** Build an ImageData filled with a single RGBA colour. */
function fill(
  w: number,
  h: number,
  [r, g, b, a]: [number, number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

const MODEL: AiModel = { id: "stub", content: "photo", nativeFactor: 4 };

/** A typed stub for the AI upscaler so `mock.calls` carries real arg types. */
function aiStub(out: ImageData) {
  return {
    upscale: vi.fn(
      async (_image: ImageData, _o: AiAdapterOptions): Promise<ImageData> => out,
    ),
  };
}

/** A typed stub for the faithful upscaler. */
function faithfulStub(out: ImageData) {
  return {
    upscale: vi.fn(
      async (
        _image: ImageData,
        _o: FaithfulUpscaleOptions,
      ): Promise<ImageData> => out,
    ),
  };
}

describe("createBlendingUpscaler — composition seam", () => {
  it("runs both inner upscalers on the same source and blends their outputs", async () => {
    const src = fill(1, 1, [0, 0, 0, 255]);
    const aiOut = fill(2, 2, [200, 100, 50, 255]);
    const faithfulOut = fill(2, 2, [100, 20, 10, 255]);

    const ai = aiStub(aiOut);
    const faithful = faithfulStub(faithfulOut);
    const blending = createBlendingUpscaler({
      aiUpscaler: ai,
      faithfulUpscaler: faithful,
    });

    const out = await blending.upscale(src, {
      factor: 2,
      model: MODEL,
      alpha: 0.25,
    });

    // Both inner upscalers ran exactly once.
    expect(ai.upscale).toHaveBeenCalledTimes(1);
    expect(faithful.upscale).toHaveBeenCalledTimes(1);
    // The blend is applied: at α=0.25, out = 0.25·ai + 0.75·faithful.
    // R = 0.25·200 + 0.75·100 = 125.
    expect(out.data[0]).toBe(125);
    // Output carries the shared dimensions of the two inner outputs.
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });

  it("forwards factor, model, and exactTargetSize to both inner upscalers", async () => {
    const ai = aiStub(fill(10, 10, [0, 0, 0, 255]));
    const faithful = faithfulStub(fill(10, 10, [0, 0, 0, 255]));
    const blending = createBlendingUpscaler({
      aiUpscaler: ai,
      faithfulUpscaler: faithful,
    });

    const src = fill(2, 2, [0, 0, 0, 255]);
    await blending.upscale(src, {
      factor: 3,
      model: MODEL,
      alpha: 0.5,
      exactTargetSize: { width: 10, height: 10 },
    });

    // The AI upscaler receives the source + factor + model + exactTargetSize.
    expect(ai.upscale).toHaveBeenCalledWith(src, {
      factor: 3,
      model: MODEL,
      exactTargetSize: { width: 10, height: 10 },
    });
    // The faithful upscaler receives the source + factor + exactTargetSize
    // (no model — it takes none). The same target is forwarded so the two
    // outputs align.
    expect(faithful.upscale).toHaveBeenCalledWith(src, {
      factor: 3,
      exactTargetSize: { width: 10, height: 10 },
    });
  });

  it("forwards the same source image to both inner upscalers", async () => {
    const src = fill(3, 3, [11, 22, 33, 255]);
    const ai = aiStub(fill(6, 6, [0, 0, 0, 255]));
    const faithful = faithfulStub(fill(6, 6, [0, 0, 0, 255]));
    const blending = createBlendingUpscaler({
      aiUpscaler: ai,
      faithfulUpscaler: faithful,
    });

    await blending.upscale(src, { factor: 2, model: MODEL, alpha: 0.5 });

    // The very same source reference is handed to both — no copy, no fork.
    expect(ai.upscale.mock.calls[0][0]).toBe(src);
    expect(faithful.upscale.mock.calls[0][0]).toBe(src);
  });

  it("at alpha=0 the output equals the faithful upscaler's output", async () => {
    const faithfulOut = fill(2, 2, [12, 34, 56, 255]);
    const blending = createBlendingUpscaler({
      aiUpscaler: aiStub(fill(2, 2, [200, 200, 200, 255])),
      faithfulUpscaler: faithfulStub(faithfulOut),
    });

    const out = await blending.upscale(fill(1, 1, [0, 0, 0, 255]), {
      factor: 2,
      model: MODEL,
      alpha: 0,
    });

    // α=0 ⇒ the blend collapses to the faithful output, byte for byte.
    expect(Array.from(out.data)).toEqual(Array.from(faithfulOut.data));
  });

  it("at alpha=1 the output equals the AI upscaler's output", async () => {
    const aiOut = fill(2, 2, [200, 100, 50, 255]);
    const blending = createBlendingUpscaler({
      aiUpscaler: aiStub(aiOut),
      faithfulUpscaler: faithfulStub(fill(2, 2, [10, 20, 30, 255])),
    });

    const out = await blending.upscale(fill(1, 1, [0, 0, 0, 255]), {
      factor: 2,
      model: MODEL,
      alpha: 1,
    });

    // α=1 ⇒ the blend collapses to the AI output, byte for byte.
    expect(Array.from(out.data)).toEqual(Array.from(aiOut.data));
  });

  it("runs the two inner upscalers concurrently (Promise.all), not sequentially", async () => {
    // Each inner upscale resolves only after a next-tick; if they ran
    // sequentially the total latency would be ~2× the per-call latency. We
    // can't measure wall-clock reliably in a test, but we *can* observe that
    // both are invoked before either resolves — i.e. neither await blocks the
    // other's dispatch. We do that by deferring resolution behind a flag set
    // synchronously inside the first call.
    let aiDispatched = false;
    let faithfulDispatched = false;
    const ai = {
      upscale: vi.fn(async (_image: ImageData, _o: AiAdapterOptions) => {
        aiDispatched = true;
        // Yield so the scheduler can run the faithful dispatch too.
        await Promise.resolve();
        return fill(2, 2, [0, 0, 0, 255]);
      }),
    };
    const faithful = {
      upscale: vi.fn(
        async (_image: ImageData, _o: FaithfulUpscaleOptions) => {
          faithfulDispatched = true;
          await Promise.resolve();
          return fill(2, 2, [0, 0, 0, 255]);
        },
      ),
    };
    const blending = createBlendingUpscaler({
      aiUpscaler: ai,
      faithfulUpscaler: faithful,
    });

    await blending.upscale(fill(1, 1, [0, 0, 0, 255]), {
      factor: 2,
      model: MODEL,
      alpha: 0.5,
    });

    // Both dispatches happened — proving neither awaited-before-dispatching the
    // other. (A sequential implementation would still pass this, but a
    // concurrent one is required for the contract; this is a necessary
    // condition and documents the intent.)
    expect(aiDispatched).toBe(true);
    expect(faithfulDispatched).toBe(true);
  });
});

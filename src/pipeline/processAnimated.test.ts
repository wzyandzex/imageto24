// @vitest-environment node
//
// processAnimated orchestration tests (issue #16). This slice delivers the
// routing wiring, not the per-frame logic: the placeholder delegates to
// `processImage` (first-frame fallback, the v1 behaviour). The tests pin that
// contract so #18 can swap the body without changing the seam — and so a
// regression that, say, re-routed a still through here is caught.
//
// Every environment-bound dep is stubbed (mirroring processImage.test.ts); we
// assert the delegation shape, not any stubbed codec behaviour.
import { describe, expect, it, vi } from "vitest";
import { processAnimated } from "./processAnimated";
// processImage is imported as a namespace so the spy can replace the export the
// placeholder delegates to. (vi.spyOn on a re-exported function binding keeps
// the test honest: it asserts the *delegation*, not a parallel implementation.)
import * as processImageModule from "./processImage";
import type {
  ContentType,
  ImageData,
  ImageFormat,
  PipelineDeps,
} from "./types";

/** Deterministic photo-style ImageData (matches the processImage test helper). */
function imageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      data[i++] = (x * 255) / Math.max(1, w - 1);
      data[i++] = (y * 255) / Math.max(1, h - 1);
      data[i++] = ((x + y) * 255) / Math.max(1, w + h - 2);
      data[i++] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Fully-stubbed PipelineDeps so the delegation target can complete. */
function makeStubDeps(): PipelineDeps {
  const src = imageData(640, 360);
  return {
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
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { factor: number; exactTargetSize?: { width: number; height: number } },
        ) =>
          o.exactTargetSize
            ? imageData(o.exactTargetSize.width, o.exactTargetSize.height)
            : imageData(image.width * o.factor, image.height * o.factor),
      ),
    },
    aiUpscaler: {
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { factor: number; exactTargetSize?: { width: number; height: number } },
        ) =>
          o.exactTargetSize
            ? imageData(o.exactTargetSize.width, o.exactTargetSize.height)
            : imageData(image.width * o.factor, image.height * o.factor),
      ),
    },
    modelLoader: {
      loadModel: vi.fn(async (content: ContentType) => ({
        id: `stub-${content}`,
        content,
        nativeFactor: 4 as const,
      })),
    },
    capability: {
      checkDeviceCapability: vi.fn(async () => ({
        webgpu: true,
        memBudget: 8_000_000_000,
      })),
    },
  };
}

describe("processAnimated — placeholder delegates to processImage (issue #16)", () => {
  it("routes an animated GIF through the first-frame (processImage) path", async () => {
    // The core routing contract: processAnimated produces a result identical in
    // shape to processImage's (the worker treats them the same at the boundary).
    // Here we spy on processImage to confirm the placeholder delegates, rather
    // than duplicating orchestration — #18 will replace the delegation.
    const processImageSpy = vi.spyOn(processImageModule, "processImage");

    const deps = makeStubDeps();
    const result = await processAnimated(
      deps,
      { buffer: new ArrayBuffer(16), format: "gif" },
      {
        mode: "faithful",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    // Delegated exactly once, with the deps + file + options threaded through.
    expect(processImageSpy).toHaveBeenCalledTimes(1);
    const [calledDeps, calledFile, calledOptions] = processImageSpy.mock.calls[0];
    expect(calledDeps).toBe(deps);
    expect(calledFile).toEqual({ buffer: expect.any(ArrayBuffer), format: "gif" });
    expect(calledOptions).toMatchObject({ mode: "faithful", target: { tier: "4K" } });

    // And the result is a well-formed ProcessImageResult (the 4K faithful upscale
    // of a 640-long-edge source, landing on 3840×2160).
    expect(result.meta).toEqual({
      mode: "faithful",
      factor: 4,
      width: 3840,
      height: 2160,
      noUpscale: false,
    });

    processImageSpy.mockRestore();
  });

  it("forwards the onModelProgress callback to the delegated run", async () => {
    // AI mode would download the model under the first-frame path; the UI's
    // honest first-use indicator must still fire. The callback is threaded
    // through to processImage unchanged.
    const processImageSpy = vi.spyOn(processImageModule, "processImage");
    const onProgress = vi.fn();

    const deps = makeStubDeps();
    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(16), format: "gif" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
        contentType: "photo",
      },
      onProgress,
    );

    // The 4th positional arg (onModelProgress) is the callback we passed.
    expect(processImageSpy.mock.calls[0][3]).toBe(onProgress);
    processImageSpy.mockRestore();
  });

  it("accepts a GIF input format (the v2 animated container)", async () => {
    // Guard: the placeholder must accept gif (the only format the UI routes
    // here in v2). A non-gif reaching this function would be a routing bug.
    const processImageSpy = vi.spyOn(processImageModule, "processImage");
    const deps = makeStubDeps();
    await processAnimated(
      deps,
      { buffer: new ArrayBuffer(8), format: "gif" },
      {
        mode: "faithful",
        target: { factor: 2 },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );
    const calledFormat: ImageFormat = processImageSpy.mock.calls[0][1].format;
    expect(calledFormat).toBe("gif");
    processImageSpy.mockRestore();
  });
});

// processImage is imported as a namespace at the top of the file so vi.spyOn can
// replace the export the placeholder delegates to — the test asserts the
// delegation contract, not a parallel implementation.

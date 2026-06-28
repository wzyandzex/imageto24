// @vitest-environment node
//
// processImage orchestration tests. The pipeline is pure with respect to globals:
// every environment-bound concern (decode/encode codecs, the upscaler, model
// loading, capability detection) is replaced by an in-test stub. These tests run
// under Vitest in plain Node — no browser — and assert the orchestration flow,
// not the (stubbed) behaviour of any single step. That behaviour lands in later
// slices; this slice delivers the seam.
import { describe, expect, it, vi } from "vitest";
import { processImage } from "./processImage";
import type {
  AiModel,
  ContentType,
  ImageData,
  ImageFormat,
  PipelineDeps,
} from "./types";

/**
 * Build a deterministic, photo-style ImageData of the given size: a smooth
 * gradient where neighbouring pixels rarely share an exact colour. This is what
 * the content classifier (issue #7) needs to recognise as `photo`, so the
 * default no-override AI path routes to the general model.
 */
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

/** An anime-style ImageData: large flat colour regions with hard edges. */
function animeImageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  const band = Math.floor(w / 3);
  let i = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] =
        x < band ? [240, 248, 255] : x < band * 2 ? [255, 220, 177] : [120, 60, 40];
      data[i++] = r;
      data[i++] = g;
      data[i++] = b;
      data[i++] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Multiply an ImageData's dimensions by an integer factor (a stand-in upscale). */
function scaleUp(src: ImageData, factor: number): ImageData {
  return imageData(src.width * factor, src.height * factor);
}

interface DepCallLog {
  decode: ImageFormat[];
  faithful: { factor?: number; exactTargetSize?: { width: number; height: number } }[];
  ai: { factor?: number; exactTargetSize?: { width: number; height: number } }[];
  encode: { format: ImageFormat; lossless: boolean; preserveExif: boolean }[];
  loadModel: ContentType[];
  capability: number;
}

/**
 * Build a fully-stubbed PipelineDeps plus a call log so tests can assert which
 * steps ran and in what shape. Every step is a vi.fn so call assertions work.
 */
function makeStubDeps(opts: {
  webgpu?: boolean;
  memBudget?: number;
  srcWidth?: number;
  srcHeight?: number;
  srcKind?: "photo" | "anime";
}): { deps: PipelineDeps; log: DepCallLog } {
  const log: DepCallLog = {
    decode: [],
    faithful: [],
    ai: [],
    encode: [],
    loadModel: [],
    capability: 0,
  };
  const src =
    opts.srcKind === "anime"
      ? animeImageData(opts.srcWidth ?? 640, opts.srcHeight ?? 360)
      : imageData(opts.srcWidth ?? 640, opts.srcHeight ?? 360);

  const deps: PipelineDeps = {
    decoder: {
      decode: vi.fn(async (_buffer: ArrayBuffer, format: ImageFormat) => {
        log.decode.push(format);
        return src;
      }),
    },
    encoder: {
      encode: vi.fn(
        async (image: ImageData, o: { format: ImageFormat; lossless: boolean; preserveExif: boolean }) => {
          log.encode.push(o);
          // Encode as a tiny deterministic buffer carrying the output dimensions.
          const buf = new ArrayBuffer(8);
          new DataView(buf).setUint32(0, image.width);
          new DataView(buf).setUint32(4, image.height);
          return buf;
        },
      ),
    },
    faithfulUpscaler: {
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { factor: number; exactTargetSize?: { width: number; height: number } },
        ) => {
          log.faithful.push(o);
          if (o.exactTargetSize) {
            return imageData(o.exactTargetSize.width, o.exactTargetSize.height);
          }
          return scaleUp(image, o.factor);
        },
      ),
    },
    aiUpscaler: {
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { factor: number; model: AiModel; exactTargetSize?: { width: number; height: number } },
        ) => {
          log.ai.push(o);
          if (o.exactTargetSize) {
            return imageData(o.exactTargetSize.width, o.exactTargetSize.height);
          }
          return scaleUp(image, o.factor);
        },
      ),
    },
    modelLoader: {
      loadModel: vi.fn(async (content: ContentType) => {
        log.loadModel.push(content);
        const model: AiModel = { id: `stub-${content}`, content, nativeFactor: 4 };
        return model;
      }),
    },
    capability: {
      checkDeviceCapability: vi.fn(async () => {
        log.capability += 1;
        const webgpu = opts.webgpu ?? true;
        return {
          webgpu,
          memBudget: opts.memBudget ?? (webgpu ? 4_000_000_000 : 0),
        };
      }),
    },
  };
  return { deps, log };
}

describe("processImage — orchestration flow", () => {
  it("runs decode → upscale → encode for a faithful 4K target and threads deps", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true });
    const buffer = new ArrayBuffer(16);

    const result = await processImage(deps, { buffer, format: "png" }, {
      mode: "faithful",
      target: { tier: "4K" },
      outputFormat: "png",
      lossless: true,
      preserveExif: true,
    });

    // Capability was probed once.
    expect(log.capability).toBe(1);
    // Decoded once with the input format.
    expect(log.decode).toEqual(["png"]);
    // Upscaled once via the faithful adapter, with the resolved factor.
    expect(log.faithful).toHaveLength(1);
    expect(log.ai).toHaveLength(0);
    expect(log.faithful[0].factor).toBe(4);
    // Encoded once with the requested output options.
    expect(log.encode).toEqual([
      { format: "png", lossless: true, preserveExif: true },
    ]);
    // No AI model load in faithful mode.
    expect(log.loadModel).toHaveLength(0);
    // Meta reflects the faithful upscale landing precisely on the 4K tier
    // (native 4× of a 640-long-edge source is 2560, so a residual Lanczos
    // resize brings the output to the exact 3840 target — PRD default path).
    expect(log.faithful[0].exactTargetSize).toEqual({ width: 3840, height: 2160 });
    expect(result.meta).toEqual({
      mode: "faithful",
      factor: 4,
      width: 3840,
      height: 2160,
      noUpscale: false,
    });
  });

  it("loads the AI model (routed by content type) before upscaling in AI mode", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "jpeg" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "webp",
        lossless: false,
        preserveExif: false,
        contentType: "anime",
      },
    );

    // AI mode ⇒ model loaded once, with the anime content type, AI upscaler called.
    expect(log.loadModel).toEqual(["anime"]);
    expect(log.ai).toHaveLength(1);
    expect(result.meta.mode).toBe("ai");
    expect(result.meta.factor).toBe(4);
  });

  it("routes AI to the photo model by classifying a photo-style source when no override is given", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true, srcKind: "photo" });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "jpeg" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "webp",
        lossless: false,
        preserveExif: false,
      },
    );

    // No override ⇒ the classifier inspects the decoded pixels and returns photo.
    expect(log.loadModel).toEqual(["photo"]);
  });
});

describe("processImage — content-type routing (issue #7, ADR-0003)", () => {
  it("routes AI to the anime model by classifying an anime-style source when no override is given", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true, srcKind: "anime" });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
      },
    );

    // Flat-colour source ⇒ classifier returns anime ⇒ anime model loads (lazy).
    expect(log.loadModel).toEqual(["anime"]);
  });

  it("a manual override beats the detected content type (photo source, anime override)", async () => {
    // Source looks like a photo, but the user forces anime.
    const { deps, log } = makeStubDeps({ webgpu: true, srcKind: "photo" });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "jpeg" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "webp",
        lossless: false,
        preserveExif: false,
        contentType: "anime",
      },
    );

    // The override wins regardless of what the classifier would have returned.
    expect(log.loadModel).toEqual(["anime"]);
  });

  it("a manual override beats the detected content type (anime source, photo override)", async () => {
    // Source looks like anime, but the user forces photo.
    const { deps, log } = makeStubDeps({ webgpu: true, srcKind: "anime" });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: false,
        contentType: "photo",
      },
    );

    expect(log.loadModel).toEqual(["photo"]);
  });
});

describe("processImage — graceful degradation (ADR-0002)", () => {
  it("falls back to faithful mode when WebGPU is unavailable", async () => {
    const { deps, log } = makeStubDeps({ webgpu: false });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
        contentType: "photo",
      },
    );

    // AI was requested but the device can't run it ⇒ no model load, faithful path.
    expect(log.loadModel).toHaveLength(0);
    expect(log.faithful).toHaveLength(1);
    expect(log.ai).toHaveLength(0);
    expect(result.meta.mode).toBe("faithful");
  });

  it("falls back to faithful when AI cost exceeds the device memory budget", async () => {
    // 640×360 source, 4K target ⇒ factor 4. A 1 KiB budget cannot fit it.
    const { deps, log } = makeStubDeps({ webgpu: true, memBudget: 1024 });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    // WebGPU was present, but the memory gate refused AI before model load.
    expect(log.loadModel).toHaveLength(0);
    expect(log.faithful).toHaveLength(1);
    expect(result.meta.mode).toBe("faithful");
  });
});

describe("processImage — boundary rule (target below source)", () => {
  it("skips upscale and surfaces noUpscale when the target is not larger", async () => {
    // Source is already 4K; a 4K target is not an upscale.
    const { deps, log } = makeStubDeps({
      webgpu: true,
      srcWidth: 3840,
      srcHeight: 2160,
    });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "faithful",
        target: { tier: "4K" },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    // Decode + encode still run (caller gets a usable file), but no upscale.
    expect(log.decode).toHaveLength(1);
    expect(log.faithful).toHaveLength(0);
    expect(log.ai).toHaveLength(0);
    expect(log.encode).toHaveLength(1);
    expect(result.meta.noUpscale).toBe(true);
    expect(result.meta.factor).toBeUndefined();
    // Output dimensions equal the source.
    expect(result.meta.width).toBe(3840);
    expect(result.meta.height).toBe(2160);
  });
});

describe("processImage — resolution control variants (issue #8)", () => {
  it("honours an explicit factor with no residual adjustment", async () => {
    // 640×360 source, explicit 3× target. The native output already equals the
    // goal (src × factor), so no exactTargetSize is requested and the factor is
    // threaded straight through — "custom dimensions honored exactly" at the
    // seam, for the factor variant.
    const { deps, log } = makeStubDeps({ webgpu: true });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "faithful",
        target: { factor: 3 },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    expect(log.faithful).toHaveLength(1);
    expect(log.faithful[0].factor).toBe(3);
    // No residual ⇒ no exact target — the native 3× output is the goal.
    expect(log.faithful[0].exactTargetSize).toBeUndefined();
    expect(result.meta).toEqual({
      mode: "faithful",
      factor: 3,
      width: 1920,
      height: 1080,
      noUpscale: false,
    });
  });

  it("honours a custom long edge exactly via a residual Lanczos resize", async () => {
    // 640×360 source, custom long edge 3000 ⇒ raw 3000/640 ≈ 4.69 ⇒ nearest
    // supported 4× ⇒ native long edge 2560 ⇒ residual +440 (target larger than
    // native). The orchestrator must request an exactTargetSize landing on the
    // custom edge, aspect-preserved (3000 × 1688). This proves the custom path
    // resolves the factor AND lands exactly on the requested size.
    const { deps, log } = makeStubDeps({ webgpu: true });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "faithful",
        target: { customLongEdge: 3000 },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    expect(log.faithful).toHaveLength(1);
    expect(log.faithful[0].factor).toBe(4);
    // The residual triggered an exact-target request, landing precisely on the
    // custom long edge with aspect ratio preserved.
    expect(log.faithful[0].exactTargetSize).toEqual({
      width: 3000,
      height: Math.round((360 * 3000) / 640),
    });
    expect(result.meta.factor).toBe(4);
    expect(result.meta.width).toBe(3000);
    expect(result.meta.height).toBe(Math.round((360 * 3000) / 640));
    expect(result.meta.noUpscale).toBe(false);
  });

  it("surfaces noUpscale for a custom long edge at or below the source", async () => {
    // 640-long-edge source, custom 640 ⇒ not larger ⇒ no upscale, no factor.
    // The boundary rule must hold for the custom variant too (AC #4).
    const { deps, log } = makeStubDeps({ webgpu: true });

    const result = await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "faithful",
        target: { customLongEdge: 640 },
        outputFormat: "png",
        lossless: true,
        preserveExif: true,
      },
    );

    expect(log.faithful).toHaveLength(0);
    expect(log.ai).toHaveLength(0);
    expect(result.meta.noUpscale).toBe(true);
    expect(result.meta.factor).toBeUndefined();
  });
});

describe("processImage — output format resolution (issue #10)", () => {
  it("threads the chosen output format and lossless flag through to the encoder in AI mode", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "webp",
        lossless: false,
        preserveExif: false,
        contentType: "photo",
      },
    );

    // AI mode permits the full matrix: lossy WebP passes through unchanged.
    expect(log.encode).toEqual([
      { format: "webp", lossless: false, preserveExif: false },
    ]);
  });

  it("coerces a JPEG selection to lossless WebP in faithful mode (lossless promise)", async () => {
    // The UI should not offer JPEG under faithful, but the orchestrator is the
    // defensive backstop — it must never emit a lossy result. A JPEG selection
    // is coerced to lossless WebP regardless of the caller's lossless flag.
    const { deps, log } = makeStubDeps({ webgpu: true });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "faithful",
        target: { tier: "4K" },
        outputFormat: "jpeg",
        lossless: false,
        preserveExif: true,
      },
    );

    expect(log.encode).toEqual([
      { format: "webp", lossless: true, preserveExif: true },
    ]);
  });

  it("forces lossless WebP when faithful mode is selected with a lossy WebP choice", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "faithful",
        target: { tier: "4K" },
        outputFormat: "webp",
        lossless: false,
        preserveExif: true,
      },
    );

    // Faithful mode permits WebP only as a lossless container.
    expect(log.encode).toEqual([
      { format: "webp", lossless: true, preserveExif: true },
    ]);
  });

  it("coerces output to lossless when AI degrades to faithful (no WebGPU)", async () => {
    // The user picked lossy JPEG under AI mode, but the device can't run AI — so
    // the orchestrator degrades to faithful, and the lossless guard must then
    // coerce the lossy JPEG to lossless WebP. The format resolution runs *after*
    // the capability gate, so the downgrade's output is always lossless.
    const { deps, log } = makeStubDeps({ webgpu: false });

    await processImage(
      deps,
      { buffer: new ArrayBuffer(16), format: "png" },
      {
        mode: "ai",
        target: { tier: "4K" },
        outputFormat: "jpeg",
        lossless: false,
        preserveExif: true,
      },
    );

    expect(log.faithful).toHaveLength(1);
    expect(log.encode).toEqual([
      { format: "webp", lossless: true, preserveExif: true },
    ]);
  });
});

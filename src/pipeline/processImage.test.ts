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

/** Build a deterministic ImageData of the given size. */
function imageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  // A simple fill so the buffer is non-empty; content is irrelevant to these tests.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 10;
    data[i + 1] = 20;
    data[i + 2] = 30;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

/** Multiply an ImageData's dimensions by an integer factor (a stand-in upscale). */
function scaleUp(src: ImageData, factor: number): ImageData {
  return imageData(src.width * factor, src.height * factor);
}

interface DepCallLog {
  decode: ImageFormat[];
  upscale: { mode: string; factor?: number; exactTargetSize?: { width: number; height: number } }[];
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
}): { deps: PipelineDeps; log: DepCallLog } {
  const log: DepCallLog = {
    decode: [],
    upscale: [],
    encode: [],
    loadModel: [],
    capability: 0,
  };
  const src = imageData(opts.srcWidth ?? 640, opts.srcHeight ?? 360);

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
    upscaler: {
      upscale: vi.fn(
        async (
          image: ImageData,
          o: { mode: string; factor?: number; exactTargetSize?: { width: number; height: number } },
        ) => {
          log.upscale.push(o);
          // Stand-in upscale: scale by the resolved factor, then honour an exact
          // target size when the orchestrator requests a tier-precise landing.
          if (o.exactTargetSize) {
            return imageData(o.exactTargetSize.width, o.exactTargetSize.height);
          }
          return scaleUp(image, o.factor ?? 1);
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
    // Upscaled once, faithful mode, with the resolved factor.
    expect(log.upscale).toHaveLength(1);
    expect(log.upscale[0].mode).toBe("faithful");
    expect(log.upscale[0].factor).toBe(4);
    // Encoded once with the requested output options.
    expect(log.encode).toEqual([
      { format: "png", lossless: true, preserveExif: true },
    ]);
    // No AI model load in faithful mode.
    expect(log.loadModel).toHaveLength(0);
    // Meta reflects the faithful upscale landing precisely on the 4K tier
    // (native 4× of a 640-long-edge source is 2560, so a residual Lanczos
    // resize brings the output to the exact 3840 target — PRD default path).
    expect(log.upscale[0].exactTargetSize).toEqual({ width: 3840, height: 2160 });
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

    // AI mode ⇒ model loaded once, with the anime content type.
    expect(log.loadModel).toEqual(["anime"]);
    expect(log.upscale[0].mode).toBe("ai");
    expect(result.meta.mode).toBe("ai");
    expect(result.meta.factor).toBe(4);
  });

  it("defaults to the photo content type when none is provided (AI mode)", async () => {
    const { deps, log } = makeStubDeps({ webgpu: true });

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

    // ADR-0003: general (photo) model is the safe default.
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
    expect(log.upscale[0].mode).toBe("faithful");
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
    expect(log.upscale[0].mode).toBe("faithful");
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
    expect(log.upscale).toHaveLength(0);
    expect(log.encode).toHaveLength(1);
    expect(result.meta.noUpscale).toBe(true);
    expect(result.meta.factor).toBeUndefined();
    // Output dimensions equal the source.
    expect(result.meta.width).toBe(3840);
    expect(result.meta.height).toBe(2160);
  });
});

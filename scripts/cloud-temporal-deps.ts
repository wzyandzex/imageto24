/**
 * Node-side default deps for the cloud temporal GPU service MVP.
 *
 * This is intentionally a wiring module, not a production temporal-model runtime:
 * it decodes the original animated upload, upscales every frame with faithful
 * Lanczos (all-frames, no sampling), and re-encodes APNG/GIF. Real temporal model
 * weights can replace {@link createNodeCloudTemporalEnhancer} without changing the
 * HTTP or service contracts.
 */
import { decodeApngFrames } from "../src/pipeline/browser/apngParser";
import { lanczosUpscale } from "../src/pipeline/lanczos";
import { computeUpscaleFactor } from "../src/pipeline/computeUpscaleFactor";
import type {
  CloudTemporalEnhancer,
  CloudTemporalFrame,
  CloudTemporalGpuServiceDeps,
  CloudTemporalSequenceDecoder,
  CloudTemporalSequenceEncoder,
} from "../src/pipeline/cloudTemporalService";
import type { CloudTemporalSourceFormat } from "../src/pipeline/cloudTemporalJob";
import type { ImageData } from "../src/pipeline/types";

export function createNodeCloudTemporalDeps(): CloudTemporalGpuServiceDeps {
  return {
    decoder: createNodeCloudTemporalDecoder(),
    enhancer: createNodeCloudTemporalEnhancer(),
    encoder: createNodeCloudTemporalEncoder(),
  };
}

export function createNodeCloudTemporalDecoder(): CloudTemporalSequenceDecoder {
  return {
    async decodeTemporalSequence(buffer, format: CloudTemporalSourceFormat) {
      if (format === "gif") return decodeGifSequence(buffer);
      if (format === "apng") return decodeApngSequence(buffer);
      if (format === "webp") {
        throw new Error(
          "Animated WebP decode is not configured in the Node GPU service MVP. Use GIF or APNG, or inject a WebP decoder.",
        );
      }
      throw new Error(`Unsupported cloud temporal source format: ${String(format)}`);
    },
  };
}

export function createNodeCloudTemporalEnhancer(): CloudTemporalEnhancer {
  return {
    async enhanceTemporalSequence(frames, options) {
      if (frames.length === 0) return frames;
      const first = frames[0];
      const factorResult = computeUpscaleFactor(
        { width: first.imageData.width, height: first.imageData.height },
        options.target,
      );
      if (factorResult.noUpscale || factorResult.factor === undefined) {
        // Still return clones so the service never mutates caller-owned frames.
        return frames.map((frame) => cloneFrame(frame));
      }
      const factor = factorResult.factor;
      return frames.map((frame) => ({
        ...frame,
        imageData: lanczosUpscale(frame.imageData, factor),
      }));
    },
  };
}

export function createNodeCloudTemporalEncoder(): CloudTemporalSequenceEncoder {
  return {
    async encodeApng(frames, options) {
      // Local structural type — ambient package types live under browser codecs;
      // keep this host free of package-type coupling.
      const mod = await import("upng-js") as {
        default: {
          encode: (
            imgs: ArrayBuffer[],
            w: number,
            h: number,
            cnum: number,
            delays?: number[],
          ) => ArrayBuffer;
        };
      };
      const imgs = frames.map((frame) => copyRgbaBuffer(frame.imageData));
      const delays = frames.map((frame) => frame.delay);
      return mod.default.encode(imgs, options.width, options.height, 0, delays);
    },
    async encodeGif(frames, options) {
      const mod = await import("gifenc") as {
        GIFEncoder: (opts?: { auto?: boolean }) => {
          writeFrame: (
            index: Uint8Array,
            width: number,
            height: number,
            opts?: {
              palette?: number[][];
              delay?: number;
              repeat?: number;
              transparent?: boolean;
              transparentIndex?: number;
              dispose?: number;
            },
          ) => void;
          finish: () => void;
          bytes: () => Uint8Array;
        };
        quantize: (
          rgba: Uint8Array | Uint8ClampedArray,
          maxColors: number,
          options?: { format?: string; oneBitAlpha?: boolean },
        ) => number[][];
        applyPalette: (
          rgba: Uint8Array | Uint8ClampedArray,
          palette: number[][],
          format: string,
        ) => Uint8Array;
      };
      const { GIFEncoder, quantize, applyPalette } = mod;
      const gif = GIFEncoder();
      frames.forEach((frame, i) => {
        const rgba = frame.imageData.data;
        const palette = quantize(rgba, 256, { format: "rgba4444", oneBitAlpha: true });
        const index = applyPalette(rgba, palette, "rgba4444");
        let transparentIndex = -1;
        for (let p = 0; p < palette.length; p++) {
          const entry = palette[p];
          if (entry.length === 4 && entry[3] === 0) {
            transparentIndex = p;
            break;
          }
        }
        gif.writeFrame(index, options.width, options.height, {
          palette,
          delay: frame.delay,
          ...(i === 0 ? { repeat: 0 } : {}),
          ...(transparentIndex >= 0 ? { transparent: true, transparentIndex } : {}),
          dispose: frame.disposalType,
        });
      });
      gif.finish();
      const bytes = gif.bytes();
      return bytes.slice().buffer;
    },
  };
}

async function decodeGifSequence(buffer: ArrayBuffer): Promise<CloudTemporalFrame[]> {
  const { parseGIF, decompressFrames } = await import("gifuct-js");
  const parsed = parseGIF(buffer);
  const width: number = parsed.lsd.width;
  const height: number = parsed.lsd.height;
  const frames = decompressFrames(parsed, true) as ReadonlyArray<{
    dims: { top: number; left: number; width: number; height: number };
    delay: number;
    disposalType: number;
    patch: Uint8ClampedArray;
  }>;

  const canvas = new Uint8ClampedArray(width * height * 4);
  let previousSnapshot: Uint8ClampedArray | undefined;
  const decoded: CloudTemporalFrame[] = [];

  for (const frame of frames) {
    const { left, top, width: fw, height: fh } = frame.dims;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const srcIdx = (y * fw + x) * 4;
        const alpha = frame.patch[srcIdx + 3];
        if (alpha === 0) continue;
        const dstIdx = ((top + y) * width + (left + x)) * 4;
        canvas[dstIdx] = frame.patch[srcIdx];
        canvas[dstIdx + 1] = frame.patch[srcIdx + 1];
        canvas[dstIdx + 2] = frame.patch[srcIdx + 2];
        canvas[dstIdx + 3] = alpha;
      }
    }
    decoded.push({
      imageData: { width, height, data: new Uint8ClampedArray(canvas) },
      delay: frame.delay || 100,
      disposalType: frame.disposalType,
      blendMode: "over",
    });
    switch (frame.disposalType) {
      case 3:
        if (previousSnapshot) canvas.set(previousSnapshot);
        break;
      case 2:
        clearRect(canvas, width, left, top, fw, fh);
        break;
      default:
        break;
    }
    previousSnapshot = new Uint8ClampedArray(canvas);
  }
  return decoded;
}

async function decodeApngSequence(buffer: ArrayBuffer): Promise<CloudTemporalFrame[]> {
  const [{ Buffer }, mod] = await Promise.all([
    import("buffer"),
    import("pngjs/browser") as Promise<{
      PNG: {
        sync: { read: (buffer: { length: number } | Uint8Array) => { width: number; height: number; data: Uint8Array } };
      };
    }>,
  ]);
  const frames = await decodeApngFrames(buffer, async (pngBuffer) => {
    const bytes = new Uint8Array(pngBuffer);
    const png = mod.PNG.sync.read(Buffer.from(bytes));
    return {
      width: png.width,
      height: png.height,
      data: new Uint8ClampedArray(png.data),
    };
  });
  return frames.map((frame) => ({
    ...frame,
    blendMode: "over" as const,
  }));
}

function clearRect(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  left: number,
  top: number,
  w: number,
  h: number,
): void {
  for (let y = 0; y < h; y++) {
    const rowStart = ((top + y) * canvasWidth + left) * 4;
    for (let x = 0; x < w * 4; x++) canvas[rowStart + x] = 0;
  }
}

function cloneFrame(frame: CloudTemporalFrame): CloudTemporalFrame {
  return {
    ...frame,
    imageData: {
      width: frame.imageData.width,
      height: frame.imageData.height,
      data: new Uint8ClampedArray(frame.imageData.data),
    },
  };
}

function copyRgbaBuffer(imageData: ImageData): ArrayBuffer {
  const rgba = imageData.data;
  const buf = new ArrayBuffer(rgba.length);
  new Uint8Array(buf).set(rgba);
  return buf;
}


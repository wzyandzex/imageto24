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
import { decodeGifSequence } from "../src/pipeline/decodeGifSequence";
import { encodeGifSequence } from "../src/pipeline/encodeGifSequence";
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
      if (format === "gif") {
        const frames = await decodeGifSequence(buffer);
        return frames.map((frame) => ({ ...frame, blendMode: "over" as const }));
      }
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
      // Shared gifenc path (same as the browser animated codec).
      return encodeGifSequence(frames, {
        width: options.width,
        height: options.height,
      });
    },
  };
}

async function decodeApngSequence(buffer: ArrayBuffer): Promise<CloudTemporalFrame[]> {
  const [{ Buffer }, { PNG }] = await Promise.all([
    import("buffer"),
    import("pngjs/browser"),
  ]);
  const frames = await decodeApngFrames(buffer, async (pngBuffer) => {
    const bytes = new Uint8Array(pngBuffer);
    const png = PNG.sync.read(Buffer.from(bytes));
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


/**
 * Browser-bound pipeline dependencies: Canvas/OffscreenCanvas decode & encode.
 *
 * These live behind the injectable seam (ADR-0001, PRD "processing pipeline"):
 * the pure pipeline never touches a global; the browser wires the real codecs
 * into {@link PipelineDeps} here. These modules are environment-bound by design
 * and are *not* unit-tested under Vitest - the pure functions they wrap are the
 * tested stronghold. Playwright exercises the wired result end-to-end.
 *
 * Browser-only APIs used: `createImageBitmap`, `OffscreenCanvas` / `HTMLCanvasElement`,
 * and Canvas 2D `getImageData` / `convertToBlob`. All are standard and supported
 * in every modern browser; there is no polyfill.
 *
 * HEIC is the one input format with no browser-native decoder. Its bytes are
 * transcoded to a PNG blob via `heic2any` (lazy-loaded, issue #15) before the
 * normal createImageBitmap path; see {@link convertHeicToPng}.
 */
import type {
  DecoderDeps,
  EncodeOptions,
  EncoderDeps,
  ImageData,
  ImageFormat,
} from "../types";
import { outputMime } from "../formats";
import { applyExifOption } from "../exif";

/**
 * Lazily import heic2any once per worker and cache the resolved module.
 *
 * heic2any is a large dependency (~1.3MB bundled, including its libheif WASM);
 * importing it dynamically inside the worker keeps it out of the main bundle so
 * non-HEIC users never download it (PRD HEIC input; ADR-0001 browser-only). ESM
 * already memoizes dynamic imports, but holding the promise at module scope
 * makes the "fetched once, reused for every HEIC in a run" intent explicit and
 * matches the lazy-import helper pattern used by the AI model loader.
 */
let heic2anyLoader: Promise<typeof import("heic2any")["default"]> | undefined;

function loadHeic2any(): Promise<typeof import("heic2any")["default"]> {
  if (!heic2anyLoader) {
    heic2anyLoader = import("heic2any").then((m) => m.default);
  }
  return heic2anyLoader;
}

/**
 * Convert a HEIC blob into a PNG blob via heic2any.
 *
 * Transcoding targets PNG (lossless) so the subsequent createImageBitmap decodes
 * the full-fidelity frame, and the faithful/AI upscalers then operate on the
 * real pixels, exactly as if the user had uploaded a PNG.
 *
 * Errors are surfaced honestly: a malformed or unconvertible HEIC throws a clear
 * message rather than hanging or crashing the pipeline (PRD HEIC user story #7).
 */
async function convertHeicToPng(heicBlob: Blob): Promise<Blob> {
  const heic2any = await loadHeic2any();
  let result: Blob | Blob[];
  try {
    result = await heic2any({ blob: heicBlob, toType: "image/png" });
  } catch (err) {
    // heic2any rejects on malformed/unconvertible input. Wrap with an honest,
    // user-facing message so the pipeline reports a clear error, not a stack.
    throw new Error(
      "This HEIC file could not be converted. It may be corrupted or an " +
        "unsupported HEIC variant. Try a different file.",
      { cause: err },
    );
  }
  // heic2any returns a single blob for a still image, or an array when
  // `multiple: true` is requested. We never request multiple, but guard the
  // union so the decoder always receives exactly one image.
  return Array.isArray(result) ? result[0] : result;
}

/**
 * Decode an encoded file into RGBA {@link ImageData} via createImageBitmap + a
 * Canvas readback.
 *
 * - JPEG/PNG/WebP/AVIF are decoded natively (`decodeStrategy` "native").
 * - GIF is decoded to its first frame ("firstFrame") - createImageBitmap yields
 *   the still first frame, which is what the v1 pipeline processes (per-frame
 *   enhancement is out of scope, PRD "Out of scope").
 * - HEIC has no browser-native decoder ("convert"); the seam first transcodes it
 *   to a PNG blob via `heic2any` (lazy-loaded, see {@link convertHeicToPng}) and
 *   then decodes that blob through the same native path (issue #15, PRD HEIC
 *   input). The rest of the pipeline is unaware HEIC ever existed.
 */
export const browserDecoder: DecoderDeps = {
  async decode(buffer, format): Promise<ImageData> {
    // HEIC: convert to a PNG blob first, then decode the PNG normally. The rest
    // of the pipeline only ever sees decoded pixels - it never branches on HEIC.
    let decodable: Blob;
    if (format === "heic") {
      decodable = await convertHeicToPng(new Blob([buffer]));
    } else {
      decodable = new Blob([buffer]);
    }
    const bitmap = await createImageBitmap(decodable);
    try {
      const { canvas } = createCanvas(bitmap.width, bitmap.height);
      const ctx = get2dContext(canvas);
      ctx.drawImage(bitmap, 0, 0);
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        width: pixels.width,
        height: pixels.height,
        // Copy out of the DOM-typed ImageData into the project's plain representation.
        data: new Uint8ClampedArray(pixels.data),
      };
    } finally {
      bitmap.close?.();
    }
  },
};

/**
 * Map a pipeline output format to a Canvas toBlob MIME type. The encoder only
 * ever receives the v1 output matrix (PNG / WebP / JPEG - AVIF, GIF and HEIC
 * are input-only, see {@link outputMime}); this is a typed cast onto that helper.
 */
function mimeType(format: ImageFormat): string {
  return outputMime(format as "png" | "webp" | "jpeg");
}

/**
 * Quality argument for toBlob - only meaningful for lossy formats (issue #10).
 *
 * Faithful output is always lossless (the lossless promise), so this is only
 * reached for AI-mode lossy WebP or JPEG. A high default (0.92) keeps the
 * "enhance, then compress" result visually faithful while still shrinking the
 * file vs. the lossless path. JPEG and lossy WebP both consume it as a 0-1
 * quality; PNG ignores it (inherently lossless).
 */
const LOSSY_DEFAULT_QUALITY = 0.92;
function quality(options: EncodeOptions): number | undefined {
  if (options.lossless) return undefined;
  // Only lossy containers honour quality; PNG is always lossless regardless.
  if (options.format === "webp" || options.format === "jpeg") {
    return LOSSY_DEFAULT_QUALITY;
  }
  return undefined;
}

/**
 * Encode RGBA {@link ImageData} into an encoded file via a Canvas.
 *
 * The Canvas encoder honours `lossless` for WebP via the (non-standard) option
 * object when available, and PNG is inherently lossless. EXIF is never produced
 * by Canvas, so the caller re-attaches it from the source (see
 * {@link browserEncoderWithSource}).
 */
function drawAndEncode(image: ImageData, options: EncodeOptions): Promise<ArrayBuffer> {
  const { canvas, isOffscreen } = createCanvas(image.width, image.height);
  const ctx = get2dContext(canvas);
  const domImageData = new globalThis.ImageData(image.data, image.width, image.height);
  ctx.putImageData(domImageData, 0, 0);

  const type = mimeType(options.format);
  // For lossless WebP, pass the (Chromium-supported) option. Canvas ignores it
  // on browsers that don't support lossless WebP encode; PNG is the safe default
  // for faithful output regardless.
  const encoderOptions = options.format === "webp" && options.lossless
    ? { lossless: true } as unknown as number
    : quality(options);

  return canvasToBuffer(canvas, isOffscreen, type, encoderOptions);
}

async function canvasToBuffer(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  isOffscreen: boolean,
  type: string,
  quality: number | undefined,
): Promise<ArrayBuffer> {
  let blob: Blob;
  if (isOffscreen) {
    blob = await (canvas as OffscreenCanvas).convertToBlob({
      type,
      ...(quality !== undefined ? { quality } : {}),
    });
  } else {
    // Main-thread HTML canvas path (only reached when OffscreenCanvas is absent).
    const html = canvas as HTMLCanvasElement;
    blob = await new Promise<Blob>((resolve, reject) => {
      html.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
        type,
        quality,
      );
    });
  }
  return blob.arrayBuffer();
}

/**
 * Build an encoder that re-attaches EXIF from the *source* file (PRD / issue #4:
 * "EXIF preserved by default"). The Canvas encoder strips metadata, so we keep
 * the original bytes and splice the EXIF APP1 back onto the JPEG output.
 *
 * PNG/WebP/AVIF outputs carry no EXIF from Canvas and there is nothing to
 * re-attach; `applyExifOption` is a no-op for them. A non-JPEG *source* (e.g.
 * HEIC) also yields no JPEG APP1 EXIF to re-attach - `extractExifSegment` treats
 * it as "no EXIF" rather than throwing (issue #15).
 */
export function browserEncoderWithSource(source: ArrayBuffer | undefined): EncoderDeps {
  return {
    async encode(image: ImageData, options: EncodeOptions): Promise<ArrayBuffer> {
      const encoded = await drawAndEncode(image, options);
      return applyExifOption(
        source,
        encoded,
        options.preserveExif,
        options.format === "jpeg",
      );
    },
  };
}

/**
 * Get a 2D rendering context typed uniformly across OffscreenCanvas and the
 * HTML canvas. The TS DOM lib types `getContext("2d")` as a union including the
 * bitmap-rendering context, which lacks the pixel APIs we need; this narrows it.
 */
function get2dContext(
  canvas: OffscreenCanvas | HTMLCanvasElement,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  // Both context types share the 2D pixel API surface we use; assert the union.
  return ctx as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}

/**
 * Create a canvas, preferring OffscreenCanvas (available in workers and on the
 * main thread in modern browsers). Returns whether the result is offscreen so
 * callers can pick the right encode path without touching the worker-unavailable
 * `HTMLCanvasElement` global.
 */
function createCanvas(
  width: number,
  height: number,
): { canvas: OffscreenCanvas | HTMLCanvasElement; isOffscreen: boolean } {
  if (typeof OffscreenCanvas !== "undefined") {
    return { canvas: new OffscreenCanvas(width, height), isOffscreen: true };
  }
  // Fallback: a canvas element (older browsers without OffscreenCanvas).
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return { canvas, isOffscreen: false };
}

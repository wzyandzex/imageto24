/**
 * Browser-bound pipeline dependencies: Canvas/OffscreenCanvas decode & encode.
 *
 * These live behind the injectable seam (ADR-0001, PRD §"processing pipeline"):
 * the pure pipeline never touches a global; the browser wires the real codecs
 * into {@link PipelineDeps} here. These modules are environment-bound by design
 * and are *not* unit-tested under Vitest — the pure functions they wrap are the
 * tested stronghold. Playwright exercises the wired result end-to-end.
 *
 * Browser-only APIs used: `createImageBitmap`, `OffscreenCanvas` / `HTMLCanvasElement`,
 * and Canvas 2D `getImageData` / `convertToBlob`. All are standard and supported
 * in every modern browser; there is no polyfill.
 */
import type {
  DecoderDeps,
  EncodeOptions,
  EncoderDeps,
  ImageData,
  ImageFormat,
} from "../types";
import { applyExifOption } from "../exif";

/**
 * Decode an encoded file into RGBA {@link ImageData} via createImageBitmap + a
 * Canvas readback. JPEG/PNG/WebP/AVIF/GIF(first frame) are all browser-native.
 */
export const browserDecoder: DecoderDeps = {
  async decode(buffer, _format): Promise<ImageData> {
    // createImageBitmap handles all browser-native formats including GIF first frame.
    const blob = new Blob([buffer]);
    const bitmap = await createImageBitmap(blob);
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

/** Map a pipeline ImageFormat to a Canvas toBlob MIME type. */
function mimeType(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "jpeg":
      return "image/jpeg";
    case "avif":
      return "image/avif";
    case "gif":
      // Canvas cannot encode animated GIF; encode as PNG for faithful output.
      return "image/png";
  }
}

/** Quality argument for toBlob — only meaningful for lossy formats. */
function quality(_options: EncodeOptions): number | undefined {
  // Faithful mode is always lossless; lossy quality tuning is a later slice.
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
 * re-attach; `applyExifOption` is a no-op for them.
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

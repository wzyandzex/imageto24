/**
 * Environment-agnostic animated-GIF decode (gifuct-js + disposal compositing).
 *
 * Shared by the browser animated codec and the Node cloud temporal host so both
 * paths composite patches the same way (disposal 0/1/2/3, transparency, delays).
 * gifuct-js is lazy-imported so non-GIF users never pay for it.
 */
import type { DecodedAnimatedFrame, ImageData } from "./types";

/**
 * Decode an animated GIF into full-canvas, disposal-resolved frames.
 *
 * Each frame is an independent RGBA still the upscaler can process without
 * knowing GIF semantics. Delay is already in milliseconds from gifuct-js.
 */
export async function decodeGifSequence(
  buffer: ArrayBuffer,
): Promise<DecodedAnimatedFrame[]> {
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

  // Persistent compositor canvas (RGBA). Starts fully transparent.
  const canvas = new Uint8ClampedArray(width * height * 4);
  // Snapshot for disposal type 3 (restore to previous).
  let previousSnapshot: Uint8ClampedArray | undefined;

  const decoded: DecodedAnimatedFrame[] = [];
  for (const frame of frames) {
    const { left, top, width: fw, height: fh } = frame.dims;

    // Composite the patch at its offset, honouring alpha (0 ⇒ leave underneath).
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

    // Copy: the next frame mutates `canvas`.
    const imageData: ImageData = {
      width,
      height,
      data: new Uint8ClampedArray(canvas),
    };
    decoded.push({
      imageData,
      // Missing/zero delay → GIF default 100ms.
      delay: frame.delay || 100,
      disposalType: frame.disposalType,
    });

    switch (frame.disposalType) {
      case 3:
        if (previousSnapshot) canvas.set(previousSnapshot);
        break;
      case 2:
        clearRect(canvas, width, left, top, fw, fh);
        break;
      case 0:
      case 1:
      default:
        break;
    }

    previousSnapshot = new Uint8ClampedArray(canvas);
  }

  return decoded;
}

/** Zero out a sub-rect of an RGBA buffer (disposal type 2: restore to bg). */
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

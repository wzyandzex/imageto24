/**
 * Environment-agnostic animated-GIF encode (gifenc).
 *
 * Shared by the browser animated codec and the Node cloud temporal host so both
 * paths quantize, apply palettes, and write frames the same way (256 colours,
 * rgba4444 + oneBitAlpha, forever-loop on first frame, disposal carried through).
 * gifenc is lazy-imported so non-GIF users never pay for it.
 */
import type { DecodedAnimatedFrame, ImageData } from "./types";

export interface EncodeGifSequenceOptions {
  readonly width: number;
  readonly height: number;
}

/**
 * Re-encode disposal-resolved full-canvas frames as a playable animated GIF.
 *
 * GIF's 256-colour ceiling is inherent (ADR-0006): full-colour upscales are
 * quantized per-frame, which can band photographic content. That trade-off is
 * documented; no workaround in this path.
 */
export async function encodeGifSequence(
  frames: ReadonlyArray<Pick<DecodedAnimatedFrame, "imageData" | "delay" | "disposalType">>,
  options: EncodeGifSequenceOptions,
): Promise<ArrayBuffer> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const { width, height } = options;

  const gif = GIFEncoder();

  frames.forEach((frame, i) => {
    const rgba = frame.imageData.data;
    // Per-frame local colour table: each frame may carry its own palette.
    // rgba4444 keeps alpha so transparency survives; oneBitAlpha reserves a slot.
    const palette = quantize(rgba, 256, {
      format: "rgba4444",
      oneBitAlpha: true,
    });
    const index = applyPalette(rgba, palette, "rgba4444");

    // Find the actual transparent palette index rather than assuming 0.
    let transparentIndex = -1;
    for (let p = 0; p < palette.length; p++) {
      const entry = palette[p];
      if (entry.length === 4 && entry[3] === 0) {
        transparentIndex = p;
        break;
      }
    }

    gif.writeFrame(index, width, height, {
      palette,
      delay: frame.delay,
      // NETSCAPE loop extension on first frame only; repeat: 0 ⇒ forever.
      ...(i === 0 ? { repeat: 0 } : {}),
      ...(transparentIndex >= 0
        ? { transparent: true, transparentIndex }
        : {}),
      dispose: frame.disposalType,
    });
  });

  gif.finish();
  // Standalone ArrayBuffer for worker transfer / HTTP response boundaries.
  const bytes = gif.bytes();
  return bytes.slice().buffer;
}

/** Convenience for callers that only have ImageData + timing. */
export type GifEncodeFrame = {
  readonly imageData: ImageData;
  readonly delay: number;
  readonly disposalType: number;
};

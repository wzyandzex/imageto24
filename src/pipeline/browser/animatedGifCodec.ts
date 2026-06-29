/**
 * Environment-bound animated-GIF codec (issue #18) — the browser-side
 * implementations of {@link AnimatedGifDecoderDeps} and
 * {@link AnimatedEncoderDeps}.
 *
 * Both libraries are lazy-`import()`ed inside their functions, so a user who
 * never uploads an animated GIF never downloads gifuct-js (~30KB) or gifenc
 * (~20KB) — the same lazy-load strategy the HEIC line uses for heic2any.
 *
 * This module is **not** unit-tested: it is bound to the browser codec stack
 * (gifuct-js, gifenc), just as `canvasCodec` is bound to Canvas. It is exercised
 * end-to-end by the Playwright GIF suite, which re-decodes the downloaded GIF
 * to assert frame count, dimensions, and timing (PRD stories #8–#12).
 */
import type {
  AnimatedDecoderDeps,
  AnimatedEncoderDeps,
  DecodedAnimatedFrame,
  ImageData,
} from "../types";

/* -------------------------------------------------------------------------- */
/* Decoder (gifuct-js)                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Decode an animated GIF into its per-frame, full-canvas {@link ImageData}.
 *
 * gifuct-js returns each frame as a *patch* (the sub-rect the frame actually
 * paints, at its `dims.left/top`), plus the previous frame's `disposalType`
 * telling us how to reset before drawing it. The standard compositing loop
 * composites every patch onto a persistent full-canvas buffer and yields a copy
 * per frame — so the upscaler receives an independent, disposal-resolved still
 * for each frame and never has to know GIF semantics.
 *
 * Disposal methods (per the GIF spec):
 *  - 0 (unspecified) / 1 (do not dispose): leave the canvas as-is.
 *  - 2 (restore to background): clear the previous frame's rect to transparent.
 *  - 3 (restore to previous): restore the pre-frame canvas — rare; we snapshot.
 *
 * Transparency is honoured by skipping patch pixels whose alpha is 0 (gifuct-js
 * sets alpha=0 for the transparent palette index when `buildImagePatches` is
 * true), so the composited frame carries the transparent regions forward.
 */
export const browserAnimatedGifDecoder: AnimatedDecoderDeps = {
  async decodeAnimated(buffer: ArrayBuffer): Promise<DecodedAnimatedFrame[]> {
    // Lazy-load so the codec never reaches a non-animated user's bundle.
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
    // Snapshot kept for disposal type 3 (restore to previous) — the canvas
    // state before the *previous* frame was drawn.
    let previousSnapshot: Uint8ClampedArray | undefined;

    const decoded: DecodedAnimatedFrame[] = [];
    for (const frame of frames) {
      const { left, top, width: fw, height: fh } = frame.dims;

      // Composite the patch into the canvas at its offset, honouring alpha.
      // gifuct-js's `patch` is RGBA (w*h*4); alpha=0 means "transparent", so we
      // skip those pixels and let whatever is underneath show through.
      for (let y = 0; y < fh; y++) {
        for (let x = 0; x < fw; x++) {
          const srcIdx = (y * fw + x) * 4;
          const alpha = frame.patch[srcIdx + 3];
          if (alpha === 0) continue; // transparent — leave the underlying pixel
          const dstIdx = ((top + y) * width + (left + x)) * 4;
          canvas[dstIdx] = frame.patch[srcIdx];
          canvas[dstIdx + 1] = frame.patch[srcIdx + 1];
          canvas[dstIdx + 2] = frame.patch[srcIdx + 2];
          canvas[dstIdx + 3] = alpha;
        }
      }

      // Yield a *copy* of the full canvas as this frame's ImageData. Copying is
      // required: the next frame mutates `canvas`, and the upscaler must see the
      // frame as it was at this instant.
      const imageData: ImageData = {
        width,
        height,
        data: new Uint8ClampedArray(canvas),
      };
      decoded.push({
        imageData,
        // gifuct-js reports delay already in milliseconds (gce.delay × 10); a
        // missing/zero delay is coerced to the GIF default of 100ms.
        delay: frame.delay || 100,
        disposalType: frame.disposalType,
      });

      // Apply the disposal rule for the frame we just drew, *before* the next
      // frame composites on top.
      switch (frame.disposalType) {
        case 3:
          // Restore to the state before this frame was drawn.
          if (previousSnapshot) canvas.set(previousSnapshot);
          break;
        case 2:
          // Restore to background: clear this frame's rect to transparent.
          clearRect(canvas, width, left, top, fw, fh);
          break;
        case 0:
        case 1:
        default:
          // Leave the canvas as-is; the next frame composites over it.
          break;
      }

      // Snapshot for a potential future disposal=3 (taken *after* compositing
      // but *before* any disposal 2/3 modifies the canvas — so it represents the
      // "current frame drawn" state a later restore-to-previous would target).
      previousSnapshot = new Uint8ClampedArray(canvas);
    }

    return decoded;
  },
};

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

/* -------------------------------------------------------------------------- */
/* Encoder (gifenc)                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Re-encode a sequence of enhanced frames as a playable animated GIF.
 *
 * gifenc's pipeline per frame: `quantize` (Wu quantization to a ≤256 palette,
 * `rgba4444` + `oneBitAlpha` so transparency keeps a slot) → `applyPalette`
 * (per-pixel indices) → `writeFrame` (palette + delay + transparency). The
 * loop count defaults to 0 (forever), preserving the original animation's
 * looping (PRD story #11). Delays are carried through 1:1.
 *
 * GIF's 256-colour ceiling is an inherent limit (ADR-0006): the faithful
 * upscale's full-colour output is quantized per-frame, which can introduce
 * banding on photographic content. That's the documented trade of GIF's
 * universal playback; no workaround in v2.
 */
export const browserAnimatedGifEncoder: AnimatedEncoderDeps = {
  async encodeAnimated(
    frames: ReadonlyArray<{
      imageData: ImageData;
      delay: number;
      disposalType: number;
    }>,
    options: { width: number; height: number },
  ): Promise<ArrayBuffer> {
    const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
    const { width, height } = options;

    const gif = GIFEncoder();

    frames.forEach((frame, i) => {
      const rgba = frame.imageData.data;
      // Per-frame local colour table: each frame may carry its own palette, so a
      // frame with different colours still renders correctly. 256 is GIF's max.
      // `rgba4444` keeps alpha in the quantize so transparency survives; with
      // `oneBitAlpha` the palette reserves a slot for fully-transparent pixels.
      const palette = quantize(rgba, 256, {
        format: "rgba4444",
        oneBitAlpha: true,
      });
      const index = applyPalette(rgba, palette, "rgba4444");

      // Find the ACTUAL transparent palette index rather than assuming 0: the
      // reserved transparent slot from `oneBitAlpha` can land anywhere in the
      // palette, so a hardcoded 0 would mislabel a real colour as transparent.
      // Scan the palette for an entry whose alpha channel is 0.
      let transparentIndex = -1;
      for (let p = 0; p < palette.length; p++) {
        const entry = palette[p];
        // rgba4444 palette entries are [r, g, b, a]; a === 0 ⇒ transparent slot.
        if (entry.length === 4 && entry[3] === 0) {
          transparentIndex = p;
          break;
        }
      }
      const hasTransparent = transparentIndex >= 0;

      gif.writeFrame(index, width, height, {
        palette,
        delay: frame.delay,
        // The NETSCAPE loop extension belongs on the first frame only; gifenc
        // emits it once per writeFrame otherwise. `repeat: 0` ⇒ loop forever
        // (preserve the original animation's looping, PRD story #11).
        ...(i === 0 ? { repeat: 0 } : {}),
        // Only enable transparency if a transparent slot was actually reserved.
        ...(hasTransparent
          ? { transparent: true, transparentIndex }
          : {}),
        // Carry the original disposal method through so the re-encoded GIF
        // composites identically on playback (PRD story #12).
        dispose: frame.disposalType,
      });
    });

    gif.finish();
    // Copy into a standalone ArrayBuffer for the worker transfer boundary.
    const bytes = gif.bytes();
    return bytes.slice().buffer;
  },
};

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
  ImageData,
} from "../types";
import { decodeGifSequence } from "../decodeGifSequence";

/* -------------------------------------------------------------------------- */
/* Decoder (gifuct-js) — shared compositing in decodeGifSequence               */
/* -------------------------------------------------------------------------- */

/**
 * Browser binding for the shared GIF compositor. Lazy gifuct-js import and
 * disposal compositing live in {@link decodeGifSequence} so the Node cloud host
 * cannot drift from the browser path.
 */
export const browserAnimatedGifDecoder: AnimatedDecoderDeps = {
  decodeAnimated: decodeGifSequence,
};

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

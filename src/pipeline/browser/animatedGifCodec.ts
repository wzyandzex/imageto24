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
} from "../types";
import { decodeGifSequence } from "../decodeGifSequence";
import { encodeGifSequence } from "../encodeGifSequence";

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
/* Encoder (gifenc) — shared quantize/write in encodeGifSequence               */
/* -------------------------------------------------------------------------- */

/**
 * Browser binding for the shared GIF encoder. Quantization, transparency slot
 * selection, and forever-loop headers live in {@link encodeGifSequence}.
 *
 * GIF's 256-colour ceiling is an inherent limit (ADR-0006).
 */
export const browserAnimatedGifEncoder: AnimatedEncoderDeps = {
  encodeAnimated: encodeGifSequence,
};

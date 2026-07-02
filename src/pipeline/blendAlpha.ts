/**
 * Pure alpha-blend math — the testable core of enhancement strength (ADR-0008).
 *
 * The blending upscaler ({@link createBlendingUpscaler} in `upscaler.ts`) runs
 * both the AI and faithful upscalers and then combines their outputs. The blend
 * itself is pure pixel arithmetic with no environment dependencies, so it lives
 * here in its own module and is tested under Vitest in Node with exact pixel
 * assertions (PRD testing decisions: "α=0 → equals faithful; α=1 → equals AI;
 * α=0.5 → exact midpoint").
 *
 * `out = α × aiUpscaled + (1 − α) × lanczosUpscaled`, per channel, per pixel.
 * The result is clamped to [0, 255] via `Uint8ClampedArray` so out-of-range
 * inputs never wrap. Alpha channels are blended like any other: both inner
 * upscalers produce opaque output in the current pipeline, but blending alpha
 * verbatim keeps the operation well-defined if either ever carries transparency.
 */
import type { ImageData } from "./types";

/**
 * Linearly blend two equal-dimension RGBA images by α.
 *
 * @param ai the AI-upscaled image (weight α).
 * @param faithful the faithful (Lanczos)-upscaled image (weight 1 − α).
 * @param alpha blend ratio in [0,1]. 0 ⇒ `faithful`, 1 ⇒ `ai`, 0.5 ⇒ the
 *   exact per-pixel midpoint.
 * @returns a new {@link ImageData} of the same dimensions; inputs are untouched.
 * @throws when the two images differ in dimensions — the blending upscaler
 *   forwards the same `exactTargetSize` to both inner upscalers precisely so
 *   their outputs align, so a mismatch is a programmer error, not a user-facing
 *   condition.
 */
export function blendAlpha(
  ai: ImageData,
  faithful: ImageData,
  alpha: number,
): ImageData {
  if (ai.width !== faithful.width || ai.height !== faithful.height) {
    throw new Error(
      `blendAlpha: image dimensions must match (ai ${ai.width}×${ai.height}, ` +
        `faithful ${faithful.width}×${faithful.height})`,
    );
  }
  const n = ai.data.length;
  const out = new Uint8ClampedArray(n);
  // α clamped defensively to [0,1]; an out-of-range alpha is a caller bug, but
  // clamping keeps the output well-defined rather than overflowing on store.
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  for (let i = 0; i < n; i++) {
    out[i] = a * ai.data[i] + (1 - a) * faithful.data[i];
  }
  return { width: ai.width, height: ai.height, data: out };
}

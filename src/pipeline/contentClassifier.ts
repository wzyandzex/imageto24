/**
 * Lightweight in-browser content-type classifier (issue #7, ADR-0003).
 *
 * Decides whether an image is a `photo` or `anime` so AI mode can route to the
 * matching Real-ESRGAN model. This is the project's tested seam for content
 * routing: a pure function of an {@link ImageData} that returns in milliseconds,
 * with no GPU and no model. The browser only needs to call it on the decoded
 * pixels of each uploaded image.
 *
 * Heuristic. Real photos have smooth gradients — neighbouring pixels rarely share
 * an exact colour — so a 2×2 neighbourhood spans several distinct colours. Anime
 * and flat illustration are built from large regions of constant colour
 * separated by hard edges, so most 2×2 neighbourhoods collapse to a single
 * colour. We sample 2×2 patches on a stride, count distinct colours per patch,
 * and threshold the "monochrome-patch ratio". Per ADR-0003 the classifier need
 * not be perfect: it must be right most of the time, with the manual override as
 * the correction path, so the threshold deliberately biases toward `photo`
 * (the safe default model) on the boundary.
 */
import type { ContentType, ImageData } from "./types";

/**
 * Sampling stride in pixels. Analysing every patch would be needlessly slow;
 * a stride of 4 visits ~1/16 of the image, which is plenty of statistics for a
 * binary decision while keeping a 512² run in the low-single-digit milliseconds.
 */
const STRIDE = 4;

/**
 * Patches with exactly one distinct colour count toward "flat". A patch with two
 * or more colours counts toward "textured". Patches split exactly on a hard edge
 * (two colours) are the anime signature, so we classify them as textured too —
 * the discriminative signal is the *abundance* of single-colour patches, not the
 * presence of edges themselves.
 */
function patchDistinctColours(
  data: Uint8ClampedArray,
  x0: number,
  y0: number,
  w: number,
): number {
  // Sample up to four pixels from the 2×2 block at (x0, y0). Pack each RGBA into
  // a 32-bit key so equality is a single integer compare; use a Set to dedupe.
  const idx = (px: number, py: number) => (py * w + px) * 4;
  const colours = new Set<number>();
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const o = idx(x0 + dx, y0 + dy);
      const key =
        (data[o] << 24) |
        (data[o + 1] << 16) |
        (data[o + 2] << 8) |
        data[o + 3];
      colours.add(key);
    }
  }
  return colours.size;
}

/**
 * Decision threshold: the fraction of sampled 2×2 patches that must be
 * single-colour (flat) before we call the image `anime`. Cel-shaded art — large
 * blocks of constant colour — sits comfortably above this; photographs, even
 * clear skies, almost never reach it because sensor noise splits 2×2 patches.
 * The value is tuned against the fixture gradients in the test suite. It is a
 * symmetric cut (≥ half the patches flat ⇒ anime), not a photo-biased one: the
 * safety net for a misclassification is the manual override (ADR-0003), not a
 * conservative threshold.
 */
const FLAT_PATCH_RATIO_THRESHOLD = 0.5;

/**
 * Classify an image as `photo` or `anime`.
 *
 * Images smaller than a 2×2 patch (or that yield no samples) fall back to
 * `photo`: there is nothing to analyse, and the general model is the safe
 * default (ADR-0003). Callers can always override via the UI.
 *
 * @param imageData decoded RGBA pixels of the uploaded image.
 * @returns the detected content type — never throws.
 */
export function classifyContent(imageData: ImageData): ContentType {
  const { width, height, data } = imageData;

  // Below the analysis floor there is no patch to inspect. Default to photo
  // (the safe model, ADR-0003); callers can always override via the UI.
  if (width < 2 || height < 2) {
    return "photo";
  }

  let sampled = 0;
  let flat = 0;
  for (let y = 0; y + 1 < height; y += STRIDE) {
    for (let x = 0; x + 1 < width; x += STRIDE) {
      sampled += 1;
      if (patchDistinctColours(data, x, y, width) === 1) {
        flat += 1;
      }
    }
  }

  // No patches sampled (extremely small image after the guard above) ⇒ photo.
  if (sampled === 0) {
    return "photo";
  }

  return flat / sampled >= FLAT_PATCH_RATIO_THRESHOLD ? "anime" : "photo";
}

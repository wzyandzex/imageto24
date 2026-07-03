/**
 * Pure Lanczos resampling — the faithful-mode core.
 *
 * Lanczos interpolation is the project's "provable, lossless-in-the-mathematical-
 * sense" enlargement (see CONTEXT.md "Faithful mode" / "Interpolate"). The kernel
 * is a windowed sinc function; it is deterministic and introduces no invented
 * detail — the output is a fixed function of the input pixels, so re-running on
 * the same source yields identical pixels every time. That determinism is this
 * slice's testing moat (PRD testing decisions, issue #4).
 *
 * This module is environment-free: it operates only on {@link ImageData} and
 * numbers. The pixel loop is the one hot path, so it is written for cache
 * locality and minimal allocation (issue #47):
 *   - Separable two-pass resample (X then Y), the standard O(n·taps) decomposition.
 *   - All colour channels are resampled in a *single* tap loop per output pixel,
 *     so each tap's index/weight is read once (not once per channel) and the
 *     source row stays hot in cache.
 *   - Fully-opaque sources skip the alpha channel entirely and write 255 directly
 *     — no image the pipeline produces carries transparency in practice, so this
 *     removes ~25% of the work on the common path while staying exact for the
 *     rare image that does have an alpha ramp.
 *   - The intermediate (inter-pass) buffer is Float32: the output is 8-bit, so
 *     single precision is more than enough and halves that buffer's memory
 *     bandwidth. The precomputed weights stay Float64 for a tight sum-to-one.
 */
import type { ImageData, UpscaleFactor } from "./types";

/** Lanczos kernel support radius. a=3 is the standard choice for resampling. */
export const LANCZOS_A = 3;

/**
 * The Lanczos kernel: sinc(x) * sinc(x/a), with the removable singularity at 0
 * defined as 1 (its limit). Pure function of a number.
 */
export function lanczosKernel(x: number, a: number = LANCZOS_A): number {
  if (x === 0) return 1;
  if (x <= -a || x >= a) return 0;
  const pix = Math.PI * x;
  return (a * Math.sin(pix) * Math.sin(pix / a)) / (pix * pix);
}

/**
 * Sample one output column of source indices/weights, precomputed once per axis.
 * Each output pixel maps to a fixed set of input taps with clamped (mirrored via
 * clamp) indices, so the result is deterministic regardless of input content.
 */
export interface AxisTaps {
  /** For each output coordinate, the input indices it reads (length === 2a). */
  readonly indices: Int32Array;
  /** For each output coordinate, the kernel weights (length === 2a). */
  readonly weights: Float64Array;
  readonly taps: number;
  readonly outSize: number;
}

/** Clamp an index into [0, size). Boundary handling: clamp to edge. */
export function clampIndex(i: number, size: number): number {
  if (i < 0) return 0;
  if (i >= size) return size - 1;
  return i;
}

/**
 * Precompute the Lanczos taps for one axis (source size → target size).
 *
 * Output coordinate o maps to source centre `o * scale - 0.5 * (scale - 1)` where
 * scale = srcSize / dstSize; we then sample the 2a taps around that centre and
 * normalise their weights so they sum to 1 (a fixed property of Lanczos, but we
 * normalise defensively against float drift).
 */
export function precomputeAxis(srcSize: number, dstSize: number, a: number = LANCZOS_A): AxisTaps {
  const scale = srcSize / dstSize;
  // When downscaling, widen the filter footprint so we don't alias.
  const filterScale = scale > 1 ? scale : 1;
  const support = a * filterScale;

  const taps = Math.ceil(support) * 2;
  const indices = new Int32Array(dstSize * taps);
  const weights = new Float64Array(dstSize * taps);

  // Scratch buffer for one output pixel's raw (pre-normalisation) weights. Hoisted
  // out of the loop below so we allocate once per axis, not once per output pixel
  // (issue #47) — thousands of tiny allocations at a 4K long edge otherwise.
  const tmpW = new Float64Array(taps);

  for (let o = 0; o < dstSize; o++) {
    // Centre of output pixel o in source coordinates.
    const centre = (o + 0.5) * scale - 0.5;
    const left = Math.floor(centre - support) + 1;
    // Accumulate weights so the taps sum to 1.
    let weightSum = 0;
    for (let t = 0; t < taps; t++) {
      const srcIndex = left + t;
      // Divide the kernel argument by filterScale when downscaling (standard
      // Lanczos-for-resize anti-aliasing); for pure upscale filterScale === 1.
      const arg = (srcIndex - centre) / filterScale;
      const w = lanczosKernel(arg, a);
      tmpW[t] = w;
      weightSum += w;
      indices[o * taps + t] = clampIndex(srcIndex, srcSize);
    }
    // Normalise (defensive against float drift; for pure upscale sum≈1 already).
    const inv = weightSum !== 0 ? 1 / weightSum : 0;
    for (let t = 0; t < taps; t++) {
      weights[o * taps + t] = tmpW[t] * inv;
    }
  }

  return { indices, weights, taps, outSize: dstSize };
}

/**
 * Is every pixel fully opaque (alpha === 255)? Fully-opaque sources take the
 * fast path that skips resampling the alpha channel and writes 255 directly.
 * Pure; reads only the alpha bytes.
 */
export function isFullyOpaque(data: Uint8ClampedArray): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return false;
  }
  return true;
}

/**
 * X-axis pass: resample `src` (RGBA) horizontally into an interleaved RGBA
 * Float32 intermediate of size (dstW × srcH). All resampled channels are
 * accumulated in one tap loop so each tap index/weight is read once.
 *
 * @param withAlpha when false the alpha channel is not resampled (left 0 in the
 *   intermediate); the Y pass writes a constant 255 for opaque images.
 */
function resampleAxisX(
  src: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  taps: AxisTaps,
  withAlpha: boolean,
): Float32Array {
  const dstW = taps.outSize;
  const nTaps = taps.taps;
  const out = new Float32Array(dstW * srcH * 4);
  for (let y = 0; y < srcH; y++) {
    const rowBase = y * srcW * 4;
    const outRow = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const tapBase = x * nTaps;
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (let t = 0; t < nTaps; t++) {
        const w = taps.weights[tapBase + t];
        const p = rowBase + taps.indices[tapBase + t] * 4;
        r += src[p] * w;
        g += src[p + 1] * w;
        b += src[p + 2] * w;
        if (withAlpha) alpha += src[p + 3] * w;
      }
      const o = outRow + x * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = alpha;
    }
  }
  return out;
}

/**
 * Y-axis pass: resample the interleaved RGBA Float32 intermediate vertically and
 * write the final RGBA `Uint8ClampedArray` (which clamps to [0,255] on store).
 * All channels accumulate in one tap loop.
 *
 * @param withAlpha when false a constant 255 is written for alpha (opaque fast
 *   path); when true the resampled alpha is stored.
 */
function resampleAxisY(
  inter: Float32Array,
  interW: number,
  taps: AxisTaps,
  withAlpha: boolean,
): Uint8ClampedArray {
  const dstH = taps.outSize;
  const nTaps = taps.taps;
  const out = new Uint8ClampedArray(interW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const tapBase = y * nTaps;
    const outRow = y * interW * 4;
    for (let x = 0; x < interW; x++) {
      const colBase = x * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      for (let t = 0; t < nTaps; t++) {
        const w = taps.weights[tapBase + t];
        const p = taps.indices[tapBase + t] * interW * 4 + colBase;
        r += inter[p] * w;
        g += inter[p + 1] * w;
        b += inter[p + 2] * w;
        if (withAlpha) alpha += inter[p + 3] * w;
      }
      const o = outRow + colBase;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = withAlpha ? alpha : 255;
    }
  }
  return out;
}

/**
 * Core separable resample from a source to an explicit (dstW × dstH), shared by
 * {@link lanczosUpscale} and {@link lanczosResize}. Opaque sources skip the alpha
 * channel; the result is deterministic — the taps depend only on the sizes, and
 * the pixel loop is a fixed weighted sum.
 */
function resampleTo(src: ImageData, dstW: number, dstH: number, a: number): ImageData {
  const srcW = src.width;
  const srcH = src.height;

  const tapsX = precomputeAxis(srcW, dstW, a);
  const tapsY = precomputeAxis(srcH, dstH, a);

  const withAlpha = !isFullyOpaque(src.data);

  // X pass: src → interleaved intermediate (dstW × srcH), then Y pass → final.
  const inter = resampleAxisX(src.data, srcW, srcH, tapsX, withAlpha);
  const data = resampleAxisY(inter, dstW, tapsY, withAlpha);

  return { width: dstW, height: dstH, data };
}

/**
 * Upscale an image by an integer factor using Lanczos resampling.
 *
 * Deterministic by construction: the taps depend only on (srcSize, dstSize, a),
 * and the pixel loop is a fixed weighted sum. Re-running on the same input yields
 * identical output bytes (see {@link lanczos.test}).
 *
 * @param src        source pixels (RGBA).
 * @param factor     integer upscale multiple (2/3/4 — see {@link UpscaleFactor}).
 * @param a          kernel support radius; defaults to the standard a=3.
 */
export function lanczosUpscale(
  src: ImageData,
  factor: UpscaleFactor,
  a: number = LANCZOS_A,
): ImageData {
  return resampleTo(src, src.width * factor, src.height * factor, a);
}

/**
 * Resize an image to an arbitrary target size (used for the residual down/up
 * adjustment that lands the output exactly on a tier's long edge after the
 * native integer upscale — see computeUpscaleFactor "residualAdjustment").
 *
 * Same deterministic Lanczos machinery, but with arbitrary (non-integer) sizes.
 */
export function lanczosResize(
  src: ImageData,
  dstW: number,
  dstH: number,
  a: number = LANCZOS_A,
): ImageData {
  return resampleTo(src, dstW, dstH, a);
}

/**
 * Compute the exact target dimensions that land a source on a given long edge,
 * preserving aspect ratio. Used when applying a residual adjustment to a tier.
 */
export function dimsForLongEdge(
  srcW: number,
  srcH: number,
  longEdge: number,
): { width: number; height: number } {
  const srcLong = Math.max(srcW, srcH);
  const scale = longEdge / srcLong;
  // Round to nearest integer pixel; aspect ratio preserved within rounding.
  return {
    width: Math.round(srcW * scale),
    height: Math.round(srcH * scale),
  };
}

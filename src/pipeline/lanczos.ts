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
 * numbers. The pixel loop is the one hot path; we keep it allocation-light and
 * free of any global or async access so it runs identically in Node (Vitest) and
 * in the browser.
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

  for (let o = 0; o < dstSize; o++) {
    // Centre of output pixel o in source coordinates.
    const centre = (o + 0.5) * scale - 0.5;
    const left = Math.floor(centre - support) + 1;
    // Accumulate weights so the taps sum to 1.
    let weightSum = 0;
    const tmpW = new Float64Array(taps);
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
 * Resample a single channel plane along the X axis using precomputed taps.
 * Pure: depends only on its arguments.
 */
function resampleAxisX(
  src: Uint8ClampedArray | Float64Array,
  srcW: number,
  srcH: number,
  channel: number, // 0..3 offset into RGBA stride
  taps: AxisTaps,
): Float64Array {
  const dstW = taps.outSize;
  const out = new Float64Array(dstW * srcH);
  const nTaps = taps.taps;
  for (let y = 0; y < srcH; y++) {
    const rowBase = y * srcW * 4;
    for (let x = 0; x < dstW; x++) {
      const tapBase = x * nTaps;
      let acc = 0;
      for (let t = 0; t < nTaps; t++) {
        const srcIdx = taps.indices[tapBase + t];
        const w = taps.weights[tapBase + t];
        acc += src[rowBase + srcIdx * 4 + channel] * w;
      }
      out[y * dstW + x] = acc;
    }
  }
  return out;
}

/**
 * Resample along the Y axis from an intermediate X-pass result.
 * Pure: depends only on its arguments.
 */
function resampleAxisY(
  inter: Float64Array,
  interW: number,
  tapsY: AxisTaps,
): Float64Array {
  const dstH = tapsY.outSize;
  const out = new Float64Array(interW * dstH);
  const nTaps = tapsY.taps;
  for (let y = 0; y < dstH; y++) {
    const tapBase = y * nTaps;
    for (let x = 0; x < interW; x++) {
      let acc = 0;
      for (let t = 0; t < nTaps; t++) {
        const srcIdx = tapsY.indices[tapBase + t];
        const w = tapsY.weights[tapBase + t];
        acc += inter[srcIdx * interW + x] * w;
      }
      out[y * interW + x] = acc;
    }
  }
  return out;
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
  const srcW = src.width;
  const srcH = src.height;
  const dstW = srcW * factor;
  const dstH = srcH * factor;

  const tapsX = precomputeAxis(srcW, dstW, a);
  const tapsY = precomputeAxis(srcH, dstH, a);

  const out = new Uint8ClampedArray(dstW * dstH * 4);

  for (let c = 0; c < 4; c++) {
    // X pass: src → intermediate (dstW × srcH).
    const inter = resampleAxisX(src.data, srcW, srcH, c, tapsX);
    // Y pass: intermediate → final (dstW × dstH).
    const final = resampleAxisY(inter, dstW, tapsY);
    for (let i = 0; i < final.length; i++) {
      out[i * 4 + c] = final[i];
    }
  }

  return { width: dstW, height: dstH, data: out };
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
  const srcW = src.width;
  const srcH = src.height;

  const tapsX = precomputeAxis(srcW, dstW, a);
  const tapsY = precomputeAxis(srcH, dstH, a);

  const out = new Uint8ClampedArray(dstW * dstH * 4);

  for (let c = 0; c < 4; c++) {
    const inter = resampleAxisX(src.data, srcW, srcH, c, tapsX);
    const final = resampleAxisY(inter, dstW, tapsY);
    for (let i = 0; i < final.length; i++) {
      out[i * 4 + c] = final[i];
    }
  }

  return { width: dstW, height: dstH, data: out };
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

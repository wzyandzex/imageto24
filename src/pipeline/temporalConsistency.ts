/**
 * Free, CPU-only temporal-consistency pass for animated sequences.
 *
 * This is **not** a neural temporal model. It:
 *  1. Upscales every frame with faithful Lanczos (all frames, no sampling).
 *  2. Blends each upscaled frame with its temporal neighbours so high-frequency
 *     flicker between independently upscaled frames is reduced.
 *
 * Used by the local cloud-temporal host when no paid GPU / large weights are
 * available (zero-cost 2a path). Neural weights can still replace the whole
 * enhancer later without changing the HTTP contract.
 */
import { lanczosUpscale } from "./lanczos";
import { computeUpscaleFactor } from "./computeUpscaleFactor";
import type { ImageData, TargetSpec } from "./types";

export interface TemporalConsistencyOptions {
  readonly target: TargetSpec;
  /**
   * Enhancement strength 0–100 from the UI. Maps to neighbour-blend weight:
   * 0 ⇒ pure per-frame Lanczos (no temporal mix); 100 ⇒ strongest free
   * temporal smoothing allowed by this path.
   */
  readonly enhancementStrength: number;
}

export interface TemporalConsistencyFrame {
  readonly imageData: ImageData;
  readonly delay: number;
  readonly disposalType: number;
  readonly blendMode?: "source" | "over";
}

/**
 * Max neighbour weight at full strength. Kept modest so the free path never
 * turns into a smear filter; neural temporal models remain the high-quality goal.
 */
export const TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT = 0.35;

/**
 * Map UI strength (0–100) to neighbour blend weight in [0, max].
 * Exported for unit tests and honest UI copy.
 */
export function temporalNeighbourWeight(enhancementStrength: number): number {
  const s = Number.isFinite(enhancementStrength) ? enhancementStrength : 0;
  const clamped = s < 0 ? 0 : s > 100 ? 100 : s;
  return (clamped / 100) * TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT;
}

/**
 * Upscale every frame with Lanczos, then apply a symmetric temporal blend:
 *   out_i = (1 − 2w) · f_i + w · f_{i−1} + w · f_{i+1}
 * with edge frames using only the available neighbour (weight w on one side).
 */
export function enhanceWithTemporalConsistency(
  frames: readonly TemporalConsistencyFrame[],
  options: TemporalConsistencyOptions,
): TemporalConsistencyFrame[] {
  if (frames.length === 0) return [];

  const first = frames[0];
  const factorResult = computeUpscaleFactor(
    { width: first.imageData.width, height: first.imageData.height },
    options.target,
  );

  const upscaled: TemporalConsistencyFrame[] = frames.map((frame) => {
    if (factorResult.noUpscale || factorResult.factor === undefined) {
      return cloneFrame(frame);
    }
    return {
      ...frame,
      imageData: lanczosUpscale(frame.imageData, factorResult.factor),
    };
  });

  const w = temporalNeighbourWeight(options.enhancementStrength);
  if (w <= 0 || upscaled.length === 1) {
    return upscaled;
  }

  return upscaled.map((frame, i) => {
    const prev = i > 0 ? upscaled[i - 1].imageData : null;
    const next = i < upscaled.length - 1 ? upscaled[i + 1].imageData : null;
    return {
      ...frame,
      imageData: blendWithNeighbours(frame.imageData, prev, next, w),
    };
  });
}

/**
 * Blend centre with optional prev/next. When only one neighbour exists, that
 * neighbour gets weight `w` and centre gets `1 − w`. With both, each neighbour
 * gets `w` and centre gets `1 − 2w` (clamped so centre never goes negative).
 */
export function blendWithNeighbours(
  centre: ImageData,
  prev: ImageData | null,
  next: ImageData | null,
  neighbourWeight: number,
): ImageData {
  const w = neighbourWeight < 0 ? 0 : neighbourWeight > 0.5 ? 0.5 : neighbourWeight;
  if (w === 0 || (!prev && !next)) {
    return {
      width: centre.width,
      height: centre.height,
      data: new Uint8ClampedArray(centre.data),
    };
  }

  const hasPrev = !!prev;
  const hasNext = !!next;
  const wp = hasPrev ? w : 0;
  const wn = hasNext ? w : 0;
  const wc = 1 - wp - wn;

  const n = centre.data.length;
  const out = new Uint8ClampedArray(n);
  const c = centre.data;
  const p = prev?.data;
  const nx = next?.data;

  for (let i = 0; i < n; i++) {
    let v = wc * c[i];
    if (p) v += wp * p[i];
    if (nx) v += wn * nx[i];
    out[i] = v;
  }

  return { width: centre.width, height: centre.height, data: out };
}

function cloneFrame(frame: TemporalConsistencyFrame): TemporalConsistencyFrame {
  return {
    ...frame,
    imageData: {
      width: frame.imageData.width,
      height: frame.imageData.height,
      data: new Uint8ClampedArray(frame.imageData.data),
    },
  };
}

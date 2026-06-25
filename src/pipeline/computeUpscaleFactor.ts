/**
 * Pure resolution-control logic — no environment access.
 *
 * Resolves a user's resolution goal (target tier, explicit factor, or custom
 * long-edge) into the integer upscale factor the model/algorithm natively
 * operates at, including the "target below source" boundary rule
 * (PRD user story #21, §Resolution control).
 *
 * This is one of the few pipeline functions implemented in full in this slice;
 * its boundary behaviour is the testing stronghold (see PRD testing decisions).
 */
import {
  type ResolutionTier,
  type TargetSpec,
  type UpscaleFactor,
  type UpscaleFactorResult,
  TIER_LONG_EDGE,
} from "./types";

/** The integer multiples the model/algorithm natively supports. */
export const SUPPORTED_FACTORS: readonly UpscaleFactor[] = [2, 3, 4];

/** A neutral 2D size, used as the source input. */
export interface SrcSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The long edge of a source image — the dimension the upscale factor is computed
 * against (PRD §Resolution control: "computed from the source's long edge").
 */
export function longEdge(size: SrcSize): number {
  return Math.max(size.width, size.height);
}

/**
 * Resolve a tier to its target long-edge pixel count.
 */
export function tierToLongEdge(tier: ResolutionTier): number {
  return TIER_LONG_EDGE[tier];
}

/**
 * Align a raw (possibly fractional) factor to the nearest supported integer
 * multiple, clamped to [1, 4]. A raw factor below 1 (target below source) does
 * not produce a supported multiple — callers handle that via {@link UpscaleFactorResult.noUpscale}.
 */
export function alignToSupportedFactor(rawFactor: number): UpscaleFactor | undefined {
  if (rawFactor < 1) return undefined;
  if (rawFactor < 2) return undefined; // 1x means "already there"; no upscale.
  let best = SUPPORTED_FACTORS[0];
  let bestDist = Math.abs(rawFactor - best);
  for (const f of SUPPORTED_FACTORS) {
    const d = Math.abs(rawFactor - f);
    if (d < bestDist) {
      best = f;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Resolve a target spec into an upscale factor result.
 *
 * - **Tier:** target long edge comes from {@link TIER_LONG_EDGE}; raw factor is
 *   target/longEdge; align to nearest supported multiple.
 * - **Explicit factor:** used directly (validated against the supported set).
 * - **Custom long edge:** same as tier but with the user-supplied pixel count.
 *
 * Boundary rule (PRD #21): when the requested target long edge is not greater
 * than the source long edge, {@link UpscaleFactorResult.noUpscale} is true and
 * no factor is returned — callers surface this to the user instead of no-op'ing.
 */
export function computeUpscaleFactor(
  srcSize: SrcSize,
  target: TargetSpec,
): UpscaleFactorResult {
  const src = longEdge(srcSize);

  // Explicit factor path: the user names the operation directly, bypassing the
  // tier/custom long-edge math. Honoured as-is; the native output already equals
  // src * factor, so there is no residual adjustment.
  if (target.factor !== undefined) {
    return {
      factor: target.factor,
      noUpscale: false,
      residualAdjustment: 0,
    };
  }

  // Determine the requested target long edge from a tier or a custom value.
  let targetLongEdge: number | undefined;
  if (target.tier !== undefined) {
    targetLongEdge = tierToLongEdge(target.tier);
  } else if (target.customLongEdge !== undefined) {
    targetLongEdge = target.customLongEdge;
  }

  if (targetLongEdge === undefined) {
    // No resolvable target: nothing meaningful to do.
    return { noUpscale: true, residualAdjustment: 0 };
  }

  // Boundary rule: target not larger than source.
  if (targetLongEdge <= src) {
    return { noUpscale: true, residualAdjustment: 0 };
  }

  const rawFactor = targetLongEdge / src;
  const factor = alignToSupportedFactor(rawFactor);

  if (factor === undefined) {
    // rawFactor is in (1, 2): larger than source but below the smallest supported
    // multiple. We round up to 2x so the upscale runs, then note a down-adjust
    // residual to land exactly on the requested target afterwards.
    const nativeOutput = src * 2;
    return {
      factor: 2,
      noUpscale: false,
      residualAdjustment: targetLongEdge - nativeOutput,
    };
  }

  const nativeOutput = src * factor;
  return {
    factor,
    noUpscale: false,
    residualAdjustment: targetLongEdge - nativeOutput,
  };
}

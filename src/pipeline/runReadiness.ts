/**
 * Run readiness — the pure, environment-free core of "is this run ready, at
 * what mode, at what cost, with what output?" (architecture review candidate #2).
 *
 * Previously these five run-orchestration concerns were smeared across App.tsx
 * (capability probe, AI-cost gating, target resolution, boundary check, output
 * resolution), wired together by two `useEffect` snap-backs that mutated user
 * state. This module concentrates them into one deep module: a single pure
 * function that takes the probed capability, the source, and the user's options,
 * and returns the whole decision in one shot. The thin `useRunReadiness` hook
 * (see useRunReadiness.ts) owns only the capability-probe side effect.
 *
 * Pure on purpose: runs under Vitest in Node with no React, no DOM, no
 * `navigator.gpu`. The decision logic that used to hide inside a 1100-line
 * component is now testable through this one interface.
 */
import { computeUpscaleFactor } from "./computeUpscaleFactor";
import { estimateAiMemoryCost, resolveAiCapability, type CapabilityDecision } from "./capability";
import { resolveOutput } from "./formats";
import type {
  ContentType,
  DeviceCapability,
  OutputFormat,
  ProcessingMode,
  ResolutionTier,
  TargetSpec,
  UpscaleFactor,
  UpscaleFactorResult,
} from "./types";

/** The three input modes the user picks a resolution goal through (issue #8). */
export type ResolutionInputMode = "tier" | "factor" | "custom";

/** What the user selected, in raw form — the input to `resolveRunReadiness`. */
export interface RunOptions {
  /** The mode the user picked (never mutated; see {@link RunReadiness.effectiveMode}). */
  mode: ProcessingMode;
  resMode: ResolutionInputMode;
  tier: ResolutionTier;
  explicitFactor: UpscaleFactor;
  /** Free-text custom long-edge entry; blank/invalid → empty target. */
  customLongEdgeText: string;
  outputFormat: OutputFormat;
  /** The WebP lossless/lossy toggle; ignored unless outputFormat is "webp". */
  lossless: boolean;
}

/** The minimal facts about the loaded image the decision needs. */
export interface SourceSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The full run-readiness decision, derived from capability + source + options.
 *
 * Every field is a pure function of the inputs — nothing here is runtime
 * state (status/result/error), which belongs to a separate hook. This is
 * exclusively "what would happen if the user triggered now."
 */
export interface RunReadiness {
  /** The probed device capability, or `null` while the probe is pending. */
  readonly capability: DeviceCapability | null;
  /** The mode that would actually run — `options.mode`, downgraded to
   *  "faithful" when AI is unavailable. The user's selection is NOT mutated;
   *  this is the derived value the UI and the run should use. */
  readonly effectiveMode: ProcessingMode;
  /** Whether AI can run, with an honest reason when it can't. `null` while the
   *  probe is pending (AI not yet known — keep the option disabled). */
  readonly aiDecision: CapabilityDecision | null;
  /** The resolved resolution goal shared by every consumer (issue #8). */
  readonly target: TargetSpec;
  /** `computeUpscaleFactor` over (source, target) — the single source of truth
   *  for the factor, the noUpscale boundary, and the AI cost. */
  readonly factorResult: UpscaleFactorResult;
  /** Whether the trigger should be disabled: probe pending, no source, or the
   *  goal is a silent no-op (target ≤ source — issue #8 boundary rule). */
  readonly triggerDisabled: boolean;
  /** The output format + lossless flag after applying the mode's constraints.
   *  Faithful mode always lands lossless (PNG or lossless WebP); AI mode
   *  honours the user's choice. Mirrors the orchestrator's defensive guard. */
  readonly effectiveOutput: { readonly format: OutputFormat; readonly lossless: boolean };
}

/** Parse the custom long-edge text. Positive integer → value; else undefined. */
export function parseCustomLongEdge(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

/**
 * Resolve the three input modes into a single {@link TargetSpec}. `custom` with
 * blank/invalid entry maps to the empty target (nothing resolvable →
 * `computeUpscaleFactor` returns noUpscale), which the boundary notice surfaces.
 */
export function resolveTarget(
  resMode: ResolutionInputMode,
  tier: ResolutionTier,
  explicitFactor: UpscaleFactor,
  customLongEdgeText: string,
): TargetSpec {
  switch (resMode) {
    case "tier":
      return { tier };
    case "factor":
      return { factor: explicitFactor };
    case "custom": {
      const parsed = parseCustomLongEdge(customLongEdgeText);
      return parsed !== undefined ? { customLongEdge: parsed } : {};
    }
  }
}

/**
 * A short label for the resolved goal, derived from {@link TargetSpec} (the
 * single source of truth — not from the raw UI inputs, so target and label can
 * never drift). Used on the trigger, the download link, and batch filenames.
 */
export function targetLabel(target: TargetSpec): string {
  if ("tier" in target && target.tier) return target.tier;
  if ("factor" in target && target.factor) return `${target.factor}x`;
  if ("customLongEdge" in target && target.customLongEdge) {
    return `${target.customLongEdge}px`;
  }
  return "—";
}

/**
 * Resolve run readiness in one shot. Pure: given the probed capability, the
 * (possibly absent) source size, and the user's options, return every derived
 * value the UI and the run need. The thin hook wraps this and owns the probe.
 *
 * Dependency order (acyclic): options → target → factorResult → aiCost →
 * aiDecision → effectiveMode → effectiveOutput. The snap-back effects the old
 * App had are gone: `options.mode` is never mutated; the downgrade lives in
 * {@link RunReadiness.effectiveMode}.
 */
export function resolveRunReadiness(
  capability: DeviceCapability | null,
  source: SourceSize | null,
  options: RunOptions,
): RunReadiness {
  const target = resolveTarget(
    options.resMode,
    options.tier,
    options.explicitFactor,
    options.customLongEdgeText,
  );

  // Single factor computation reused by every downstream consumer (absorbs
  // architecture-review candidate #4 — four recomputations collapse to one).
  const factorResult = source
    ? computeUpscaleFactor({ width: source.width, height: source.height }, target)
    : { factor: undefined, noUpscale: true } as UpscaleFactorResult;

  // AI memory cost: 0 when there's no real upscale to charge for (no source, or
  // target ≤ source). The orchestrator skips the memory gate on the noUpscale
  // path, so the UI must too — a non-zero cost only on a real upscale keeps
  // gating consistent (issue #5 AC #5).
  const aiCost =
    source && factorResult.factor !== undefined && !factorResult.noUpscale
      ? estimateAiMemoryCost(source.width * source.height, factorResult.factor)
      : 0;

  const aiDecision = capability
    ? resolveAiCapability(capability, aiCost)
    : null;

  // The user's mode wins unless AI is known-unavailable, in which case faithful
  // is the universal fallback (ADR-0002). Note this does NOT mutate
  // `options.mode` — the UI still shows the user's selection; this is the
  // derived value the run consumes.
  const effectiveMode: ProcessingMode =
    options.mode === "ai" && aiDecision && !aiDecision.canRunAi
      ? "faithful"
      : options.mode;

  const effectiveOutput = resolveOutput(
    effectiveMode,
    options.outputFormat,
    options.lossless,
  );

  const triggerDisabled = capability === null || (source !== null && factorResult.noUpscale);

  return {
    capability,
    effectiveMode,
    aiDecision,
    target,
    factorResult,
    triggerDisabled,
    effectiveOutput,
  };
}

/** Re-exported so callers don't need a separate import for the type alias. */
export type { ContentType };

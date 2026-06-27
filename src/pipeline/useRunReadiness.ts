/**
 * useRunReadiness — the thin React wrapper around {@link resolveRunReadiness}.
 *
 * Owns exactly one side effect: probing device capability once on mount. Every
 * other run-orchestration concern (AI gating, target resolution, boundary
 * check, output resolution) is pure and lives in {@link resolveRunReadiness}.
 *
 * The old App.tsx wired these with two `useEffect` snap-backs that mutated user
 * state. This hook does NOT mutate the user's selections: it returns the
 * derived {@link RunReadiness} and the caller keeps `mode`/`tier`/etc. as
 * plain state the user controls. The downgrade appears in
 * `readiness.effectiveMode`, never as a silent rewrite.
 */
import { useEffect, useMemo, useState } from "react";
import { resolveRunReadiness, type RunOptions, type RunReadiness, type SourceSize } from "./runReadiness";
import { browserCapabilityDetector } from "./browser/capability";
import type { DeviceCapability } from "./types";

/**
 * Probe capability once, then derive run readiness from it + the source + the
 * user's options. Returns the readiness and the user's mode (unchanged — the
 * hook never rewrites it).
 *
 * @param source   the loaded image's size, or null when none is loaded
 * @param options  the user's current selections (mode, tier, output, ...)
 * @returns `{ readiness, mode }` — `readiness.effectiveMode` is what the run
 *          actually targets; `mode` is what the user picked
 */
export function useRunReadiness(
  source: SourceSize | null,
  options: RunOptions,
): { readiness: RunReadiness; mode: RunOptions["mode"] } {
  const [capability, setCapability] = useState<DeviceCapability | null>(null);

  useEffect(() => {
    let cancelled = false;
    browserCapabilityDetector
      .checkDeviceCapability()
      .then((cap) => {
        if (!cancelled) setCapability(cap);
      })
      .catch(() => {
        // A probe failure must never blank the page — fall back to "no AI"
        // (ADR-0002: faithful is the universal fallback, never a hard error).
        if (!cancelled) setCapability({ webgpu: false, memBudget: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const readiness = useMemo(
    () => resolveRunReadiness(capability, source, options),
    [capability, source, options],
  );

  return { readiness, mode: options.mode };
}

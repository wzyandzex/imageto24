/**
 * Browser-bound capability detector: probes WebGPU support and estimates the AI
 * memory budget (ADR-0002 graceful degradation, issue #5).
 *
 * WebGPU is detected via `navigator.gpu`; the memory budget is a coarse estimate
 * derived from `navigator.deviceMemory` — it only needs to be good enough to
 * gate AI mode, not precise. Faithful mode ignores both and always runs.
 *
 * The *decision* of whether AI may run is not made here; it lives in the pure
 * `resolveAiCapability` (see `../capability`). This module only gathers the
 * numbers. That separation keeps the decision testable in Node without a
 * browser (PRD testing decisions: the single pure-function seam).
 */
import type { CapabilityDetector, DeviceCapability } from "../types";

/**
 * Fraction of the browser-reported device RAM we conservatively assume is
 * available to one tab for AI work. `deviceMemory` is already capped at 8 GiB and
 * over-reports what a single tab can use; browsers, the OS, and other tabs all
 * compete for the same RAM. One-third is a deliberately cautious upper bound.
 */
const AI_RAM_FRACTION = 1 / 3;

/**
 * Pure memory-budget estimate. Exported so the logic is unit-checkable without a
 * browser. Returns 0 ("could not estimate") when the declared RAM is absent or 0.
 *
 * @param declaredDeviceMemory `navigator.deviceMemory` in GiB (0 if unavailable).
 */
export function estimateMemBudget(declaredDeviceMemory: number): number {
  if (declaredDeviceMemory <= 0) return 0;
  const gib = declaredDeviceMemory * AI_RAM_FRACTION;
  return Math.round(gib * 1024 * 1024 * 1024);
}

export const browserCapabilityDetector: CapabilityDetector = {
  async checkDeviceCapability(): Promise<DeviceCapability> {
    const nav = navigator as Navigator & { gpu?: unknown };
    const webgpu = typeof nav.gpu !== "undefined";
    if (!webgpu) {
      // No WebGPU ⇒ no AI budget to estimate.
      return { webgpu: false, memBudget: 0 };
    }
    const devNav = navigator as Navigator & { deviceMemory?: number };
    // deviceMemory is capped at 8 and only available in Chromium; 0/absent
    // means "unknown", not "empty". resolveAiCapability treats 0 as unknown.
    return {
      webgpu: true,
      memBudget: estimateMemBudget(devNav.deviceMemory ?? 0),
    };
  },
};

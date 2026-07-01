/**
 * Browser-bound capability detector: probes WebGPU support and estimates the AI
 * memory budget (ADR-0002 graceful degradation, issue #5). Also probes WebCodecs
 * (`ImageDecoder`, issue #29 / ADR-0007): the animated-output format is
 * device-determined — WebCodecs-capable browsers get true-colour APNG, others
 * get 256-colour GIF — so the UI must know which branch this device is on to
 * render the output format honestly.
 *
 * WebGPU is detected via `navigator.gpu`; the memory budget is a coarse estimate
 * derived from `navigator.deviceMemory` — it only needs to be good enough to
 * gate AI mode, not precise. WebCodecs is `typeof ImageDecoder`, the same gate
 * the worker's codec pair uses (`hasWebCodecs` in deps.ts), so the UI and the
 * pipeline can never disagree. Faithful mode ignores both and always runs.
 *
 * The *decision* of whether AI may run is not made here; it lives in the pure
 * `resolveAiCapability` (see `../capability`). This module only gathers the
 * numbers/flags. That separation keeps the decision testable in Node without a
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
    // WebCodecs ImageDecoder gates the high-fidelity animated-output path
    // (ADR-0007, issue #29). Same check as `hasWebCodecs()` in deps.ts, so the
    // UI's label can never disagree with the worker's codec-pair resolution.
    const webCodecs = typeof ImageDecoder !== "undefined";
    if (!webgpu) {
      // No WebGPU ⇒ no AI budget to estimate.
      return { webgpu: false, memBudget: 0, webCodecs };
    }
    const devNav = navigator as Navigator & { deviceMemory?: number };
    // deviceMemory is capped at 8 and only available in Chromium; 0/absent
    // means "unknown", not "empty". resolveAiCapability treats 0 as unknown.
    return {
      webgpu: true,
      memBudget: estimateMemBudget(devNav.deviceMemory ?? 0),
      webCodecs,
    };
  },
};

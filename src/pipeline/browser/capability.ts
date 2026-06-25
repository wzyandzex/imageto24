/**
 * Browser-bound capability detector: probes WebGPU support and estimates the AI
 * memory budget (ADR-0002 graceful degradation).
 *
 * WebGPU is detected via `navigator.gpu`; the memory budget is a coarse estimate
 * derived from `navigator.deviceMemory` and `navigator.hardwareConcurrency` — it
 * only needs to be good enough to gate AI mode, not precise. Faithful mode
 * ignores both and always runs.
 */
import type { CapabilityDetector, DeviceCapability } from "../types";

/** A coarse AI-memory estimate in bytes, or 0 when nothing can be inferred. */
function estimateMemBudget(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  // deviceMemory is capped at 8 and only available in Chromium; treat 0/absent
  // as "unknown" rather than "no memory".
  const declared = nav.deviceMemory ?? 0;
  if (declared === 0) return 0;
  // Reserve most of declared RAM for AI work as a rough upper bound.
  return Math.round(declared * 1024 * 1024 * 1024);
}

export const browserCapabilityDetector: CapabilityDetector = {
  async checkDeviceCapability(): Promise<DeviceCapability> {
    const nav = navigator as Navigator & { gpu?: unknown };
    const webgpu = typeof nav.gpu !== "undefined";
    return { webgpu, memBudget: webgpu ? estimateMemBudget() : 0 };
  },
};

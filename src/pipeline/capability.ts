/**
 * Pure capability-resolution logic — no environment access (issue #5).
 *
 * This is the project's single testing stronghold for the device-capability
 * check: the *decision* of whether AI mode may run is a pure function of an
 * injected capability descriptor (`DeviceCapability`) and an estimated AI
 * memory cost, independent of how those numbers were probed. The browser probe
 * (`browserCapabilityDetector`) only gathers the numbers; this module decides.
 *
 * Domain terms follow `CONTEXT.md` ("Device capability check", "Graceful
 * degradation"). Faithful mode is always available — it runs anywhere — so a
 * denied AI decision never withdraws faithful mode (universal fallback,
 * ADR-0002).
 */
import type { DeviceCapability } from "./types";

/** Bytes per RGBA pixel — the project's in-memory `ImageData` representation. */
const BYTES_PER_PIXEL = 4;

/**
 * A coarse upper bound on the memory an AI run will consume: the source pixel
 * buffer plus the upscaled output pixel buffer, both at 4 bytes/pixel.
 *
 * These two buffers must exist for the whole run regardless of how inference is
 * executed. The other term — Real-ESRGAN's activation tensors — used to scale
 * with the *whole image* and was the real OOM risk, but tiled inference (issue
 * #44, {@link aiUpscale}) now bounds the per-inference working set to a single
 * (padded) tile, a fixed constant independent of image size. So this buffer-based
 * figure is a fair estimate of the size-dependent peak rather than an optimistic
 * floor, and the gate no longer needs to refuse large images purely to avoid an
 * unbounded single-shot activation allocation.
 *
 * @param srcPixels   the source image's pixel count (width × height).
 * @param factor      the integer upscale factor the AI model operates at. A
 *   factor of 1 (no upscale) charges source plus a same-size output.
 */
export function estimateAiMemoryCost(
  srcPixels: number,
  factor: number,
): number {
  const outPixels = srcPixels * factor * factor;
  return (srcPixels + outPixels) * BYTES_PER_PIXEL;
}

/**
 * The outcome of deciding whether AI mode may run on this device.
 *
 * `reason` is null when AI is permitted; otherwise it is a short, honest,
 * user-facing sentence explaining *why* AI is unavailable (the honesty matters:
 * per ADR-0002 we surface the cause rather than hiding it).
 */
export interface CapabilityDecision {
  /** Whether AI mode may run. */
  readonly canRunAi: boolean;
  /** Always true — faithful mode is the universal fallback (ADR-0002). */
  readonly faithfulAvailable: true;
  /**
   * A user-facing explanation of why AI is unavailable, or null when AI is
   * permitted. Drives the disabled-state messaging in the UI.
   */
  readonly reason: string | null;
}

/** WebGPU is absent — the honest, device-level reason AI cannot run. */
const NO_WEBGPU_REASON =
  "AI Enhance needs WebGPU, which your browser or device doesn't support. Faithful mode works everywhere.";

/** The AI work would not fit in the estimated device memory budget. */
const INSUFFICIENT_MEMORY_REASON =
  "AI Enhance would exceed your device's estimated memory for this image size. Faithful mode is the safe path.";

/**
 * Decide whether AI mode may run, given a device capability and the AI memory
 * cost of the requested work.
 *
 * Rules (ADR-0002 graceful degradation):
 * - No WebGPU ⇒ AI denied, reason cites WebGPU. Memory budget is irrelevant.
 * - WebGPU present, `memBudget` is 0 ⇒ the budget could not be estimated
 *   (deviceMemory is unavailable outside Chromium); do not refuse AI on that
 *   basis — allow it and let the runtime fail per-image if it truly can't cope.
 * - WebGPU present, `memBudget` known and the cost fits (strictly under budget)
 *   ⇒ AI allowed.
 * - WebGPU present but the cost meets/exceeds the budget ⇒ AI denied, reason
 *   cites memory.
 *
 * In every denial, faithful mode remains available — this function never
 * withdraws it.
 */
export function resolveAiCapability(
  capability: DeviceCapability,
  aiMemoryCost: number,
): CapabilityDecision {
  if (!capability.webgpu) {
    return {
      canRunAi: false,
      faithfulAvailable: true,
      reason: NO_WEBGPU_REASON,
    };
  }

  // memBudget 0 means "could not estimate", not "zero memory available".
  if (capability.memBudget > 0 && aiMemoryCost >= capability.memBudget) {
    return {
      canRunAi: false,
      faithfulAvailable: true,
      reason: INSUFFICIENT_MEMORY_REASON,
    };
  }

  return {
    canRunAi: true,
    faithfulAvailable: true,
    reason: null,
  };
}

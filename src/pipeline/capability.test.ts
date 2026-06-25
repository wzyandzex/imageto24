// @vitest-environment node
//
// Pure capability-resolution tests (issue #5, PRD testing decisions).
//
// `resolveAiCapability` and `estimateAiMemoryCost` are pure functions of an
// injected capability descriptor and a memory cost — they never touch the
// environment. These tests exercise the degradation logic across varied
// descriptors (the Vitest half of issue #5's acceptance criteria), independent
// of any real browser probe.
import { describe, expect, it } from "vitest";
import { estimateAiMemoryCost, resolveAiCapability } from "./capability";
import type { DeviceCapability } from "./types";

describe("estimateAiMemoryCost", () => {
  it("charges 4 bytes/pixel for the source buffer plus the upscaled output", () => {
    // 640×360 source at 4× → 640*360*4 input bytes + 2560*1440*4 output bytes.
    const cost = estimateAiMemoryCost(640 * 360, 4);
    expect(cost).toBe(640 * 360 * 4 + 2560 * 1440 * 4);
  });

  it("scales with factor and source size", () => {
    const base = estimateAiMemoryCost(1000 * 1000, 2);
    const bigger = estimateAiMemoryCost(1000 * 1000, 4);
    const huge = estimateAiMemoryCost(2000 * 2000, 4);
    expect(bigger).toBeGreaterThan(base);
    expect(huge).toBeGreaterThan(bigger);
  });
});

describe("resolveAiCapability — no WebGPU", () => {
  const noGpu: DeviceCapability = { webgpu: false, memBudget: 0 };

  it("denies AI with a WebGPU-explanation reason and marks faithful available", () => {
    const decision = resolveAiCapability(noGpu, 0);
    expect(decision.canRunAi).toBe(false);
    expect(decision.faithfulAvailable).toBe(true);
    expect(decision.reason).toMatch(/WebGPU/i);
  });

  it("ignores a large memory budget when WebGPU is absent", () => {
    const decision = resolveAiCapability(
      { webgpu: false, memBudget: 8_000_000_000 },
      0,
    );
    expect(decision.canRunAi).toBe(false);
    expect(decision.reason).toMatch(/WebGPU/i);
  });
});

describe("resolveAiCapability — WebGPU present", () => {
  const fourGib: DeviceCapability = { webgpu: true, memBudget: 4_000_000_000 };

  it("allows AI when the cost fits an unknown budget (0 = unknown, not empty)", () => {
    // memBudget 0 means "we could not estimate"; do not refuse on that basis.
    const decision = resolveAiCapability(
      { webgpu: true, memBudget: 0 },
      500_000_000,
    );
    expect(decision.canRunAi).toBe(true);
  });

  it("allows AI when the cost fits the declared budget", () => {
    const decision = resolveAiCapability(fourGib, 500_000_000);
    expect(decision.canRunAi).toBe(true);
    expect(decision.reason).toBeNull();
  });

  it("denies AI when the cost exceeds the declared budget, with a memory reason", () => {
    const decision = resolveAiCapability(fourGib, 5_000_000_000);
    expect(decision.canRunAi).toBe(false);
    expect(decision.reason).toMatch(/memory/i);
    // Faithful is still offered.
    expect(decision.faithfulAvailable).toBe(true);
  });

  it("denies AI when the cost exactly equals the budget (no headroom)", () => {
    const decision = resolveAiCapability(fourGib, 4_000_000_000);
    expect(decision.canRunAi).toBe(false);
    expect(decision.reason).toMatch(/memory/i);
  });
});

describe("resolveAiCapability — universal fallback", () => {
  it("never withdraws faithful mode, regardless of how badly AI fails", () => {
    const noGpu = resolveAiCapability({ webgpu: false, memBudget: 0 }, 0);
    const tinyMem = resolveAiCapability(
      { webgpu: true, memBudget: 1024 },
      1_000_000_000,
    );
    expect(noGpu.faithfulAvailable).toBe(true);
    expect(tinyMem.faithfulAvailable).toBe(true);
  });
});

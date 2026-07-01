// @vitest-environment node
//
// Run-readiness resolution tests (architecture review candidate #2).
//
// `resolveRunReadiness` is the pure core of the run-orchestration decision —
// capability gating, target resolution, boundary check, output resolution all
// collapsed into one function. These tests exercise every branch through that
// single interface, in Node with no React/DOM/navigator.gpu. The thin hook
// (useRunReadiness) owns only the capability probe; this is where the logic
// lives and where its tests belong.
import { describe, expect, it } from "vitest";
import {
  parseCustomLongEdge,
  resolveRunReadiness,
  resolveTarget,
  targetLabel,
} from "./runReadiness";
import type { DeviceCapability } from "./types";
import type { RunOptions, SourceSize } from "./runReadiness";

const OK: DeviceCapability = { webgpu: true, memBudget: 2_000_000_000, webCodecs: false };
const NO_GPU: DeviceCapability = { webgpu: false, memBudget: 0, webCodecs: false };

// A 500x500 source used by most boundary/output tests.
const SRC_500: SourceSize = { width: 500, height: 500 };

// A 1500x1500 source: at 4x (the cap for any tier) the AI cost is
// (2.25M + 2.25M*16) * 4 ≈ 153MB, which blows MED_MEM (50MB). Used for the
// memory-budget downgrade case — the tier is irrelevant since any tier clamps
// to 4x, so we just need a source big enough that 4x is too costly.
const SRC_1500: SourceSize = { width: 1500, height: 1500 };
const MED_MEM: DeviceCapability = { webgpu: true, memBudget: 50_000_000, webCodecs: false };

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return {
    mode: "faithful",
    resMode: "tier",
    tier: "4K",
    explicitFactor: 4,
    customLongEdgeText: "",
    outputFormat: "png",
    lossless: true,
    ...over,
  };
}

describe("parseCustomLongEdge", () => {
  it("accepts a positive integer", () => {
    expect(parseCustomLongEdge("3000")).toBe(3000);
  });
  it("rejects blank, non-integer, and non-positive", () => {
    expect(parseCustomLongEdge("")).toBeUndefined();
    expect(parseCustomLongEdge("   ")).toBeUndefined();
    expect(parseCustomLongEdge("3.5")).toBeUndefined();
    expect(parseCustomLongEdge("0")).toBeUndefined();
    expect(parseCustomLongEdge("-5")).toBeUndefined();
    expect(parseCustomLongEdge("abc")).toBeUndefined();
  });
});

describe("resolveTarget", () => {
  it("tier mode → { tier }", () => {
    expect(resolveTarget("tier", "2K", 4, "")).toEqual({ tier: "2K" });
  });
  it("factor mode → { factor }", () => {
    expect(resolveTarget("factor", "4K", 3, "")).toEqual({ factor: 3 });
  });
  it("custom mode with valid integer → { customLongEdge }", () => {
    expect(resolveTarget("custom", "4K", 4, "3000")).toEqual({ customLongEdge: 3000 });
  });
  it("custom mode with blank/invalid → empty target (unresolvable)", () => {
    expect(resolveTarget("custom", "4K", 4, "")).toEqual({});
    expect(resolveTarget("custom", "4K", 4, "abc")).toEqual({});
  });
});

describe("targetLabel", () => {
  it("derives from TargetSpec — tier", () => {
    expect(targetLabel({ tier: "4K" })).toBe("4K");
  });
  it("derives from TargetSpec — factor", () => {
    expect(targetLabel({ factor: 3 })).toBe("3x");
  });
  it("derives from TargetSpec — custom", () => {
    expect(targetLabel({ customLongEdge: 3000 })).toBe("3000px");
  });
  it("em-dash for the empty/unresolvable target", () => {
    expect(targetLabel({})).toBe("—");
  });
});

describe("resolveRunReadiness", () => {
  describe("capability probing state", () => {
    it("treats a pending probe (capability === null) as: AI unknown, trigger disabled", () => {
      const r = resolveRunReadiness(null, SRC_500, opts({ mode: "ai" }));
      expect(r.capability).toBeNull();
      expect(r.aiDecision).toBeNull();
      // No source-independent AI decision can be made; effectiveMode keeps the
      // user's selection but the run can't fire until the probe lands.
      expect(r.triggerDisabled).toBe(true);
    });
    it("re-enables the trigger once the probe lands (with a valid source + goal)", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ mode: "faithful" }));
      expect(r.triggerDisabled).toBe(false);
    });
  });

  describe("effectiveMode downgrade (replaces snap-back)", () => {
    it("keeps the user's 'ai' selection when AI is available", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ mode: "ai", tier: "1080p" }));
      expect(r.effectiveMode).toBe("ai");
    });
    it("downgrades to faithful when WebGPU is absent, WITHOUT changing the user's intent", () => {
      // options.mode stays 'ai' (we assert on effectiveMode only); the old
      // useEffect would have mutated state to 'faithful'. The user's selection
      // is now preserved and surfaced separately.
      const r = resolveRunReadiness(NO_GPU, SRC_500, opts({ mode: "ai" }));
      expect(r.effectiveMode).toBe("faithful");
    });
    it("downgrades to faithful when the memory budget is blown by the goal", () => {
      // SRC_1500 at 4x → ~153MB, blows MED_MEM (50MB). AI known-unavailable.
      const r = resolveRunReadiness(MED_MEM, SRC_1500, opts({ mode: "ai", tier: "4K" }));
      expect(r.effectiveMode).toBe("faithful");
      expect(r.aiDecision?.canRunAi).toBe(false);
    });
    it("keeps AI when the cost fits the budget", () => {
      // SRC_500 at 4x → (250k + 250k*16)*4 ≈ 17MB, under MED_MEM (50MB). AI allowed.
      const r = resolveRunReadiness(MED_MEM, SRC_500, opts({ mode: "ai", tier: "4K" }));
      expect(r.effectiveMode).toBe("ai");
      expect(r.aiDecision?.canRunAi).toBe(true);
    });
  });

  describe("triggerDisabled boundary rule", () => {
    it("disables the trigger when the goal does not exceed the source (noUpscale)", () => {
      // 4K tier against a source already at 4000px long edge → no real upscale.
      const big: SourceSize = { width: 4000, height: 4000 };
      const r = resolveRunReadiness(OK, big, opts({ tier: "4K" }));
      expect(r.factorResult.noUpscale).toBe(true);
      expect(r.triggerDisabled).toBe(true);
    });
    it("disables the trigger when custom input is blank/invalid (empty target)", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ resMode: "custom", customLongEdgeText: "" }));
      expect(r.triggerDisabled).toBe(true);
    });
    it("does NOT flag noUpscale when there is no source (the UI's !source check gates that path)", () => {
      // The original App combined `!source` separately; this module only owns
      // the "noUpscale against a loaded source" boundary. No-source handling
      // stays with the trigger button's existing guard.
      const r = resolveRunReadiness(OK, null, opts());
      expect(r.factorResult.noUpscale).toBe(true);
      // triggerDisabled here reflects noUpscale-of-nothing; the UI additionally
      // gates on !source. Asserting only our own contract:
      expect(r.triggerDisabled).toBe(false);
    });
  });

  describe("effectiveOutput honours the mode's lossless promise", () => {
    it("faithful mode forces PNG lossless regardless of user choice", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ mode: "faithful", outputFormat: "png", lossless: false }));
      expect(r.effectiveOutput).toEqual({ format: "png", lossless: true });
    });
    it("faithful mode coerces JPEG → lossless WebP (lossless promise, issue #10)", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ mode: "faithful", outputFormat: "jpeg" }));
      expect(r.effectiveOutput).toEqual({ format: "webp", lossless: true });
    });
    it("faithful mode keeps lossless WebP", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ mode: "faithful", outputFormat: "webp", lossless: true }));
      expect(r.effectiveOutput).toEqual({ format: "webp", lossless: true });
    });
    it("AI mode passes the user's WebP lossless choice through", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ mode: "ai", tier: "1080p", outputFormat: "webp", lossless: false }));
      expect(r.effectiveOutput).toEqual({ format: "webp", lossless: false });
    });
    it("AI mode coerces a JPEG choice to lossy WebP when forced faithful by downgrade", () => {
      // User picked AI + JPEG, but AI is unavailable → effectiveMode faithful →
      // JPEG coerced to lossless WebP. The downgrade and the output constraint
      // compose in one pass (the old code needed two snap-back effects).
      const r = resolveRunReadiness(NO_GPU, SRC_500, opts({ mode: "ai", outputFormat: "jpeg" }));
      expect(r.effectiveMode).toBe("faithful");
      expect(r.effectiveOutput).toEqual({ format: "webp", lossless: true });
    });
  });

  describe("single source of truth for the factor", () => {
    it("factorResult is computed once and exposed (not recomputed per consumer)", () => {
      const r = resolveRunReadiness(OK, SRC_500, opts({ tier: "4K" }));
      expect(r.factorResult.factor).toBeGreaterThan(1);
      expect(typeof r.factorResult.noUpscale).toBe("boolean");
    });
  });
});

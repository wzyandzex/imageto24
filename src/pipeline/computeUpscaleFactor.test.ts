// @vitest-environment node
//
// computeUpscaleFactor is pure: no globals, no DOM, no Canvas. These tests prove
// it runs under Vitest in plain Node (no browser environment) and assert the
// resolution-tier resolution logic and its boundary rules — the testing
// stronghold named in the PRD testing decisions.
import { describe, expect, it } from "vitest";
import {
  SUPPORTED_FACTORS,
  alignToSupportedFactor,
  computeUpscaleFactor,
  longEdge,
  tierToLongEdge,
} from "./computeUpscaleFactor";
import type { TargetSpec } from "./types";

describe("longEdge", () => {
  it("returns the larger dimension", () => {
    expect(longEdge({ width: 800, height: 600 })).toBe(800);
    expect(longEdge({ width: 600, height: 800 })).toBe(800);
    expect(longEdge({ width: 1024, height: 1024 })).toBe(1024);
  });
});

describe("tierToLongEdge", () => {
  it("maps each tier to its long-edge pixel target", () => {
    expect(tierToLongEdge("1080p")).toBe(1920);
    expect(tierToLongEdge("2K")).toBe(2560);
    expect(tierToLongEdge("4K")).toBe(3840);
  });
});

describe("alignToSupportedFactor", () => {
  it("aligns a raw factor to the nearest supported integer multiple", () => {
    expect(alignToSupportedFactor(2.0)).toBe(2);
    expect(alignToSupportedFactor(2.4)).toBe(2); // closer to 2 than 3
    expect(alignToSupportedFactor(2.6)).toBe(3); // closer to 3 than 2
    expect(alignToSupportedFactor(3.4)).toBe(3);
    expect(alignToSupportedFactor(3.6)).toBe(4);
    expect(alignToSupportedFactor(4.9)).toBe(4);
  });

  it("returns undefined when no upscale is meaningful (raw factor < 2)", () => {
    expect(alignToSupportedFactor(0.5)).toBeUndefined();
    expect(alignToSupportedFactor(1.0)).toBeUndefined();
    expect(alignToSupportedFactor(1.9)).toBeUndefined();
  });

  it("only ever yields a supported factor", () => {
    for (let raw = 2; raw <= 10; raw += 0.1) {
      const f = alignToSupportedFactor(raw);
      expect(f).not.toBeNull();
      expect(SUPPORTED_FACTORS).toContain(f);
    }
  });
});

describe("computeUpscaleFactor — tier path", () => {
  it("aligns a tier target to the nearest supported factor", () => {
    // src 960 → 4K (3840) ⇒ raw 4.0 ⇒ 4x, exact (no residual).
    const r = computeUpscaleFactor({ width: 960, height: 540 }, { tier: "4K" });
    expect(r).toEqual({ factor: 4, noUpscale: false, residualAdjustment: 0 });
  });

  it("records a non-zero residual when the native output differs from target", () => {
    // src 1000 → 4K (3840) ⇒ raw 3.84 ⇒ nearest 4x ⇒ native 4000 ⇒ residual −160.
    const r = computeUpscaleFactor({ width: 1000, height: 1000 }, { tier: "4K" });
    expect(r.factor).toBe(4);
    expect(r.noUpscale).toBe(false);
    expect(r.residualAdjustment).toBe(3840 - 4000);
  });

  it("rounds raw factors in (1,2) up to 2x and notes a down-adjust residual", () => {
    // src 2000 → 4K (3840) ⇒ raw 1.92 ⇒ no supported multiple ⇒ 2x ⇒ 4000 ⇒ −160.
    const r = computeUpscaleFactor({ width: 2000, height: 2000 }, { tier: "4K" });
    expect(r.factor).toBe(2);
    expect(r.noUpscale).toBe(false);
    expect(r.residualAdjustment).toBe(3840 - 4000);
  });

  it("treats each tier against a fixed source consistently", () => {
    // src 640. 1080p=1920 ⇒ 3.0 ⇒ 3x exact; 2K=2560 ⇒ 4.0 ⇒ 4x exact; 4K=3840 ⇒ 6.0 ⇒ nearest 4x.
    const r1080 = computeUpscaleFactor({ width: 640, height: 360 }, { tier: "1080p" });
    expect(r1080.factor).toBe(3);
    expect(r1080.residualAdjustment).toBe(0);

    const r2k = computeUpscaleFactor({ width: 640, height: 360 }, { tier: "2K" });
    expect(r2k.factor).toBe(4);
    expect(r2k.residualAdjustment).toBe(0);

    const r4k = computeUpscaleFactor({ width: 640, height: 360 }, { tier: "4K" });
    expect(r4k.factor).toBe(4);
    // 4x of 640 = 2560 vs target 3840 ⇒ residual +1280 (target larger than native).
    expect(r4k.residualAdjustment).toBe(3840 - 2560);
  });
});

describe("computeUpscaleFactor — explicit factor path", () => {
  it("honours the user's explicit factor with no residual", () => {
    for (const factor of [2, 3, 4] as const) {
      const r = computeUpscaleFactor(
        { width: 500, height: 500 },
        { factor },
      );
      expect(r).toEqual({ factor, noUpscale: false, residualAdjustment: 0 });
    }
  });
});

describe("computeUpscaleFactor — custom long-edge path", () => {
  it("resolves a custom pixel target like a tier", () => {
    // src 1000 → custom 3000 ⇒ raw 3.0 ⇒ 3x exact.
    const r = computeUpscaleFactor(
      { width: 1000, height: 1000 },
      { customLongEdge: 3000 },
    );
    expect(r).toEqual({ factor: 3, noUpscale: false, residualAdjustment: 0 });
  });
});

describe("computeUpscaleFactor — boundary rule (target below source)", () => {
  it("returns noUpscale when the target equals the source long edge", () => {
    const target: TargetSpec = { customLongEdge: 1000 };
    const r = computeUpscaleFactor({ width: 1000, height: 800 }, target);
    expect(r.noUpscale).toBe(true);
    expect(r.factor).toBeUndefined();
  });

  it("returns noUpscale when the target is below the source long edge", () => {
    // Asking a 4K-tier device to "upscale" an already-4K source must not run.
    const r = computeUpscaleFactor({ width: 3840, height: 2160 }, { tier: "4K" });
    expect(r.noUpscale).toBe(true);
    expect(r.factor).toBeUndefined();
    expect(r.residualAdjustment).toBe(0);
  });

  it("returns noUpscale when no target variant is provided", () => {
    const r = computeUpscaleFactor({ width: 800, height: 600 }, {});
    expect(r.noUpscale).toBe(true);
    expect(r.factor).toBeUndefined();
  });
});

describe("computeUpscaleFactor — purity", () => {
  it("is deterministic across calls (no hidden state, no globals)", () => {
    const a = computeUpscaleFactor({ width: 640, height: 360 }, { tier: "4K" });
    const b = computeUpscaleFactor({ width: 640, height: 360 }, { tier: "4K" });
    expect(a).toEqual(b);
  });
});

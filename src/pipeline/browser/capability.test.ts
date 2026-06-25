// @vitest-environment jsdom
//
// Unit tests for the browser-bound capability probe (issue #5).
//
// The pure decision logic (`resolveAiCapability`) is covered in
// `capability.test.ts`; this file covers the browser-side estimator that turns
// `navigator.deviceMemory` into a budget. The estimator is a pure exported
// helper, exercised here with varied descriptors so the budget math is locked
// without depending on a real browser.
import { describe, expect, it } from "vitest";
import { estimateMemBudget } from "@/pipeline/browser/capability";

describe("estimateMemBudget", () => {
  it("returns 0 when deviceMemory is unavailable (non-Chromium / absent)", () => {
    expect(estimateMemBudget(0)).toBe(0);
  });

  it("returns 0 for a non-positive declared RAM", () => {
    expect(estimateMemBudget(-4)).toBe(0);
  });

  it("reserves roughly one-third of the declared RAM for AI work", () => {
    // 8 GiB declared ⇒ ~2.67 GiB ≈ 2,863,311,360 bytes.
    expect(estimateMemBudget(8)).toBe(Math.round((8 / 3) * 1024 ** 3));
  });

  it("scales roughly linearly with declared RAM (rounding noise aside)", () => {
    const small = estimateMemBudget(2);
    const doubled = estimateMemBudget(4);
    // Rounding to the nearest byte can differ by 1; assert within 2 bytes.
    expect(Math.abs(doubled - small * 2)).toBeLessThanOrEqual(2);
  });
});

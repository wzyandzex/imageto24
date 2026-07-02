// @vitest-environment node
//
// Enhancement-strength alpha-blend tests (v4, ADR-0008, issue #38).
//
// The blend is the pure, pixel-exact core of enhancement strength, so these
// tests assert exact pixel values for the three anchor points (α=0/0.5/1) and
// the determinism + dimension-mismatch guard. Per the PRD testing decisions:
// "stubbed upscalers, assert exact pixel values."
import { describe, expect, it } from "vitest";
import { blendAlpha } from "./blendAlpha";
import type { ImageData } from "./types";

/** Build an ImageData from an array of [r,g,b,a] tuples, row-major. */
function fromPixels(
  w: number,
  h: number,
  pixels: Array<[number, number, number, number]>,
): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < pixels.length; p++) {
    const [r, g, b, a] = pixels[p];
    data[p * 4] = r;
    data[p * 4 + 1] = g;
    data[p * 4 + 2] = b;
    data[p * 4 + 3] = a;
  }
  return { width: w, height: h, data };
}

describe("blendAlpha — anchor points", () => {
  // Two single-pixel images that differ on every channel, so a blend is
  // observable on R/G/B/A alike.
  const ai = fromPixels(1, 1, [[200, 100, 50, 255]]);
  const faithful = fromPixels(1, 1, [[20, 40, 60, 255]]);

  it("α = 0 yields exactly the faithful output", () => {
    const out = blendAlpha(ai, faithful, 0);
    expect(out.width).toBe(1);
    expect(out.height).toBe(1);
    expect(Array.from(out.data)).toEqual([20, 40, 60, 255]);
  });

  it("α = 1 yields exactly the AI output", () => {
    const out = blendAlpha(ai, faithful, 1);
    expect(Array.from(out.data)).toEqual([200, 100, 50, 255]);
  });

  it("α = 0.5 yields the exact per-pixel/per-channel midpoint", () => {
    const out = blendAlpha(ai, faithful, 0.5);
    // (200+20)/2 = 110, (100+40)/2 = 70, (50+60)/2 = 55, alpha 255.
    expect(Array.from(out.data)).toEqual([110, 70, 55, 255]);
  });

  it("does not mutate either input", () => {
    const aiBefore = Array.from(ai.data);
    const faithfulBefore = Array.from(faithful.data);
    blendAlpha(ai, faithful, 0.5);
    expect(Array.from(ai.data)).toEqual(aiBefore);
    expect(Array.from(faithful.data)).toEqual(faithfulBefore);
  });
});

describe("blendAlpha — intermediate ratios", () => {
  it("applies a non-trivial α (0.25) per channel across multiple pixels", () => {
    const ai = fromPixels(2, 1, [
      [0, 0, 0, 255],
      [100, 200, 0, 255],
    ]);
    const faithful = fromPixels(2, 1, [
      [100, 100, 100, 255],
      [20, 40, 60, 255],
    ]);
    // α = 0.25 ⇒ 0.25*ai + 0.75*faithful.
    const out = blendAlpha(ai, faithful, 0.25);
    expect(Array.from(out.data)).toEqual([
      // pixel 0: 0.25*0 + 0.75*100 = 75 (all channels faithful)
      75, 75, 75, 255,
      // pixel 1: R 0.25*100+0.75*20=40, G 0.25*200+0.75*40=80, B 0.25*0+0.75*60=45
      40, 80, 45, 255,
    ]);
  });
});

describe("blendAlpha — determinism", () => {
  it("returns identical bytes for identical inputs across calls", () => {
    const ai = fromPixels(2, 2, [
      [10, 20, 30, 255],
      [40, 50, 60, 255],
      [70, 80, 90, 255],
      [100, 110, 120, 255],
    ]);
    const faithful = fromPixels(2, 2, [
      [200, 190, 180, 255],
      [170, 160, 150, 255],
      [140, 130, 120, 255],
      [110, 100, 90, 255],
    ]);
    const a = blendAlpha(ai, faithful, 0.37);
    const b = blendAlpha(ai, faithful, 0.37);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(a.data).toBeInstanceOf(Uint8ClampedArray);
  });
});

describe("blendAlpha — guards", () => {
  it("throws when the two images have different dimensions", () => {
    const ai = fromPixels(2, 2, [
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
      [0, 0, 0, 255],
    ]);
    const faithful = fromPixels(1, 1, [[0, 0, 0, 255]]);
    expect(() => blendAlpha(ai, faithful, 0.5)).toThrow(/dimensions must match/);
  });

  it("clamps an out-of-range α to [0,1] rather than overflowing", () => {
    const ai = fromPixels(1, 1, [[200, 100, 50, 255]]);
    const faithful = fromPixels(1, 1, [[20, 40, 60, 255]]);
    // α = 1.5 clamps to 1 ⇒ equals AI; α = -0.5 clamps to 0 ⇒ equals faithful.
    expect(Array.from(blendAlpha(ai, faithful, 1.5).data)).toEqual([
      200, 100, 50, 255,
    ]);
    expect(Array.from(blendAlpha(ai, faithful, -0.5).data)).toEqual([
      20, 40, 60, 255,
    ]);
  });
});

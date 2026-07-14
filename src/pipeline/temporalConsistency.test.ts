import { describe, expect, it } from "vitest";
import {
  blendWithNeighbours,
  enhanceWithTemporalConsistency,
  temporalNeighbourWeight,
  TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT,
} from "./temporalConsistency";
import type { ImageData } from "./types";

function solid(r: number, g: number, b: number, a = 255, w = 2, h = 2): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

describe("temporalNeighbourWeight", () => {
  it("is 0 at strength 0 and max at strength 100", () => {
    expect(temporalNeighbourWeight(0)).toBe(0);
    expect(temporalNeighbourWeight(100)).toBe(TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT);
    expect(temporalNeighbourWeight(50)).toBeCloseTo(TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT / 2);
  });

  it("clamps out-of-range strength", () => {
    expect(temporalNeighbourWeight(-10)).toBe(0);
    expect(temporalNeighbourWeight(200)).toBe(TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT);
  });
});

describe("blendWithNeighbours", () => {
  it("returns a copy when weight is 0", () => {
    const c = solid(10, 20, 30);
    const out = blendWithNeighbours(c, solid(0, 0, 0), solid(255, 255, 255), 0);
    expect(Array.from(out.data.slice(0, 4))).toEqual([10, 20, 30, 255]);
    expect(out.data).not.toBe(c.data);
  });

  it("midpoint-blends with both neighbours", () => {
    const c = solid(100, 100, 100);
    const prev = solid(0, 0, 0);
    const next = solid(200, 200, 200);
    // w=0.25 → centre 0.5, prev 0.25, next 0.25 → 0.5*100 + 0.25*0 + 0.25*200 = 100
    const out = blendWithNeighbours(c, prev, next, 0.25);
    expect(out.data[0]).toBe(100);
  });

  it("uses a single neighbour at the edge", () => {
    const c = solid(100, 0, 0);
    const next = solid(0, 0, 0);
    // w=0.25 → centre 0.75, next 0.25 → 75
    const out = blendWithNeighbours(c, null, next, 0.25);
    expect(out.data[0]).toBe(75);
  });
});

describe("enhanceWithTemporalConsistency", () => {
  it("clones frames when no upscale is needed and strength is 0", () => {
    // 2×2 source vs 1080p tier long-edge is still "no upscale" for tiny inputs
    // that already meet/exceed the goal? Use custom long edge equal to source.
    const frames = [
      { imageData: solid(1, 2, 3), delay: 40, disposalType: 1 },
      { imageData: solid(4, 5, 6), delay: 40, disposalType: 1 },
    ];
    const out = enhanceWithTemporalConsistency(frames, {
      target: { customLongEdge: 2 },
      enhancementStrength: 0,
    });
    // customLongEdge == source long edge → noUpscale → clones
    expect(out).toHaveLength(2);
    expect(out[0].imageData.data).not.toBe(frames[0].imageData.data);
    expect(Array.from(out[0].imageData.data.slice(0, 4))).toEqual([1, 2, 3, 255]);
  });

  it("upscales every frame at 2× and preserves timing metadata", () => {
    const frames = [
      { imageData: solid(255, 0, 0, 255, 2, 2), delay: 40, disposalType: 1, blendMode: "over" as const },
      { imageData: solid(0, 255, 0, 255, 2, 2), delay: 80, disposalType: 2, blendMode: "over" as const },
      { imageData: solid(0, 0, 255, 255, 2, 2), delay: 100, disposalType: 1, blendMode: "over" as const },
    ];
    const out = enhanceWithTemporalConsistency(frames, {
      target: { factor: 2 },
      enhancementStrength: 0,
    });
    expect(out).toHaveLength(3);
    expect(out[0].imageData.width).toBe(4);
    expect(out[0].imageData.height).toBe(4);
    expect(out[0].delay).toBe(40);
    expect(out[1].delay).toBe(80);
    expect(out[2].disposalType).toBe(1);
  });

  it("applies temporal blend at non-zero strength without dropping frames", () => {
    const frames = [
      { imageData: solid(255, 0, 0, 255, 2, 2), delay: 40, disposalType: 1 },
      { imageData: solid(0, 255, 0, 255, 2, 2), delay: 40, disposalType: 1 },
      { imageData: solid(0, 0, 255, 255, 2, 2), delay: 40, disposalType: 1 },
    ];
    const pure = enhanceWithTemporalConsistency(frames, {
      target: { factor: 2 },
      enhancementStrength: 0,
    });
    const mixed = enhanceWithTemporalConsistency(frames, {
      target: { factor: 2 },
      enhancementStrength: 100,
    });
    expect(mixed).toHaveLength(3);
    // Middle frame should differ once neighbours mix in.
    expect(Array.from(mixed[1].imageData.data)).not.toEqual(Array.from(pure[1].imageData.data));
  });
});

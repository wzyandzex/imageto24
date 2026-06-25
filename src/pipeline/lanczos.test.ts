/**
 * Tests for the faithful-mode Lanczos core.
 *
 * These tests are this slice's testing moat (PRD testing decisions / issue #4):
 *   - Determinism: identical source + factor ⇒ identical output pixels, across
 *     repeated runs (the property that makes faithful mode "provable").
 *   - Correct dimensions for a given factor.
 *   - The kernel/tap machinery is stable (sums to 1, indices in range).
 */
import { describe, expect, it } from "vitest";
import {
  clampIndex,
  dimsForLongEdge,
  lanczosKernel,
  lanczosResize,
  lanczosUpscale,
  LANCZOS_A,
  precomputeAxis,
} from "./lanczos";
import type { ImageData } from "./types";

/** Build a solid-colour RGBA image of the given size. */
function solidColor(w: number, h: number, r: number, g: number, b: number, alpha = 255): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = alpha;
  }
  return { width: w, height: h, data };
}

/** Build a checkerboard RGBA image (good edge/contrast content). */
function checkerboard(w: number, h: number, cell = 2): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const on = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0;
      const v = on ? 255 : 0;
      const i = (y * w + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** Hex-encode the pixel bytes for stable snapshot-style comparison. */
function fingerprint(img: ImageData): string {
  let s = "";
  for (let i = 0; i < img.data.length; i++) s += img.data[i].toString(16).padStart(2, "0");
  return s;
}

describe("lanczosKernel", () => {
  it("is 1 at the origin (removable singularity)", () => {
    expect(lanczosKernel(0)).toBe(1);
  });

  it("is 0 at integer multiples within support (sinc zeros)", () => {
    for (let n = 1; n < LANCZOS_A; n++) {
      expect(lanczosKernel(n)).toBeCloseTo(0, 10);
      expect(lanczosKernel(-n)).toBeCloseTo(0, 10);
    }
  });

  it("is 0 outside the support window", () => {
    expect(lanczosKernel(LANCZOS_A)).toBe(0);
    expect(lanczosKernel(-LANCZOS_A)).toBe(0);
    expect(lanczosKernel(LANCZOS_A + 0.5)).toBe(0);
  });

  it("is symmetric about the origin", () => {
    for (const x of [0.25, 0.5, 1.5, 2.7]) {
      expect(lanczosKernel(x)).toBeCloseTo(lanczosKernel(-x), 12);
    }
  });
});

describe("clampIndex", () => {
  it("clamps to the valid range", () => {
    expect(clampIndex(-3, 10)).toBe(0);
    expect(clampIndex(5, 10)).toBe(5);
    expect(clampIndex(10, 10)).toBe(9);
    expect(clampIndex(99, 10)).toBe(9);
  });
});

describe("precomputeAxis", () => {
  it("produces normalised weights (sum ≈ 1) for every output pixel", () => {
    const taps = precomputeAxis(4, 8, LANCZOS_A);
    const nTaps = taps.taps;
    for (let o = 0; o < taps.outSize; o++) {
      let sum = 0;
      for (let t = 0; t < nTaps; t++) sum += taps.weights[o * nTaps + t];
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it("keeps all source indices within range", () => {
    const srcSize = 5;
    const taps = precomputeAxis(srcSize, 15, LANCZOS_A);
    for (let i = 0; i < taps.indices.length; i++) {
      const idx = taps.indices[i];
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(srcSize);
    }
  });
});

describe("lanczosUpscale — determinism (the testing moat)", () => {
  it("produces identical pixels across repeated runs on the same source + factor", () => {
    const src = checkerboard(6, 6, 2);
    const run1 = lanczosUpscale(src, 2);
    const run2 = lanczosUpscale(src, 2);
    expect(run1.data).toEqual(run2.data);
    expect(fingerprint(run1)).toBe(fingerprint(run2));
  });

  it("produces identical pixels across runs at factor 3 and 4", () => {
    const src = checkerboard(5, 4, 1);
    for (const factor of [2, 3, 4] as const) {
      const a = lanczosUpscale(src, factor);
      const b = lanczosUpscale(src, factor);
      expect(a.data).toEqual(b.data);
    }
  });

  it("a solid colour stays the same solid colour after upscale (no energy drift)", () => {
    const src = solidColor(4, 4, 100, 150, 200);
    const out = lanczosUpscale(src, 2);
    expect(out.width).toBe(8);
    expect(out.height).toBe(8);
    for (let i = 0; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(100);
      expect(out.data[i + 1]).toBe(150);
      expect(out.data[i + 2]).toBe(200);
      expect(out.data[i + 3]).toBe(255);
    }
  });
});

describe("lanczosUpscale — dimensions", () => {
  it("doubles width and height at factor 2", () => {
    const out = lanczosUpscale(solidColor(7, 5, 0, 0, 0), 2);
    expect(out.width).toBe(14);
    expect(out.height).toBe(10);
    expect(out.data.length).toBe(14 * 10 * 4);
  });

  it("triples at factor 3 and quadruples at factor 4", () => {
    const src = solidColor(3, 3, 0, 0, 0);
    expect(lanczosUpscale(src, 3)).toHaveProperty("width", 9);
    expect(lanczosUpscale(src, 4)).toHaveProperty("width", 12);
  });

  it("preserves the alpha channel at full opacity", () => {
    const out = lanczosUpscale(solidColor(3, 3, 0, 0, 0, 255), 2);
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(255);
    }
  });
});

describe("lanczosResize", () => {
  it("is also deterministic across runs at arbitrary sizes", () => {
    const src = checkerboard(10, 10, 2);
    const a = lanczosResize(src, 20, 20);
    const b = lanczosResize(src, 20, 20);
    expect(a.data).toEqual(b.data);
  });

  it("lands on the requested dimensions", () => {
    const src = solidColor(10, 10, 0, 0, 0);
    const out = lanczosResize(src, 33, 17);
    expect(out.width).toBe(33);
    expect(out.height).toBe(17);
  });
});

describe("dimsForLongEdge", () => {
  it("preserves aspect ratio and lands the long edge on target (landscape)", () => {
    const { width, height } = dimsForLongEdge(640, 360, 3840);
    expect(Math.max(width, height)).toBe(3840);
    expect(width).toBe(3840);
    expect(height).toBe(2160);
  });

  it("preserves aspect ratio for portrait orientation", () => {
    const { width, height } = dimsForLongEdge(360, 640, 3840);
    expect(Math.max(width, height)).toBe(3840);
    expect(width).toBe(2160);
    expect(height).toBe(3840);
  });
});

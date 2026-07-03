// @vitest-environment node
//
// AI mode tests assert structure only (issue #6 / PRD testing decisions): the
// pipeline invokes the inference session correctly, produces valid ImageData at
// the requested dimensions, and releases resources. Pixel quality is explicitly
// not a CI assertion.
import { describe, expect, it, vi } from "vitest";
import {
  REAL_ESRGAN_INPUT,
  REAL_ESRGAN_OUTPUT,
  aiUpscale,
  imageDataToNchw,
  nchwToImageData,
  planTiles,
  type NchwTensor,
} from "./aiUpscale";
import type { AiInferenceSession, ImageData } from "./types";

function imageData(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 64;
    data[i + 1] = 128;
    data[i + 2] = 192;
    data[i + 3] = 255;
  }
  return { width: w, height: h, data };
}

function tensor(w: number, h: number): NchwTensor {
  const data = new Float32Array(3 * w * h);
  data.fill(0.5);
  return { width: w, height: h, data };
}

describe("AI tensor conversion", () => {
  it("converts ImageData to/from Real-ESRGAN NCHW tensors", () => {
    const src = imageData(2, 1);
    const nchw = imageDataToNchw(src);

    expect(nchw.width).toBe(2);
    expect(nchw.height).toBe(1);
    expect(nchw.data).toHaveLength(6);
    expect(nchw.data[0]).toBeCloseTo(64 / 255);
    expect(nchw.data[2]).toBeCloseTo(128 / 255);
    expect(nchw.data[4]).toBeCloseTo(192 / 255);

    const roundTrip = nchwToImageData(nchw);
    expect(roundTrip.width).toBe(2);
    expect(roundTrip.height).toBe(1);
    expect(roundTrip.data).toHaveLength(8);
    expect(roundTrip.data[3]).toBe(255);
    expect(roundTrip.data[7]).toBe(255);
  });
});

describe("aiUpscale", () => {
  it("invokes the injected session and returns valid ImageData at the requested factor", async () => {
    const src = imageData(2, 2);
    const run = vi.fn(async (feeds: Record<string, unknown>) => {
      const input = feeds[REAL_ESRGAN_INPUT] as NchwTensor;
      expect(input.width).toBe(2);
      expect(input.height).toBe(2);
      expect(input.data).toBeInstanceOf(Float32Array);
      return {
        [REAL_ESRGAN_OUTPUT]: tensor(8, 8), // Real-ESRGAN native 4× output.
      };
    });
    const release = vi.fn();
    const session: AiInferenceSession = { run, release };

    const out = await aiUpscale(session, src, { factor: 2, nativeFactor: 4 });

    expect(run).toHaveBeenCalledTimes(1);
    // The pure dispatch does NOT release the session — the loader owns its
    // lifecycle (see aiUpscale JSDoc). release must stay untouched here.
    expect(release).not.toHaveBeenCalled();
    expect(out.width).toBe(4); // requested 2×, downsampled from native 4×
    expect(out.height).toBe(4);
    expect(out.data).toBeInstanceOf(Uint8ClampedArray);
    expect(out.data).toHaveLength(4 * 4 * 4);
  });

  it("lands on an exact target size when the orchestrator requests one", async () => {
    const session: AiInferenceSession = {
      run: vi.fn(async () => ({ [REAL_ESRGAN_OUTPUT]: tensor(16, 8) })),
      release: vi.fn(),
    };

    const out = await aiUpscale(session, imageData(4, 2), {
      factor: 4,
      nativeFactor: 4,
      exactTargetSize: { width: 10, height: 5 },
    });

    expect(out.width).toBe(10);
    expect(out.height).toBe(5);
    expect(out.data).toHaveLength(10 * 5 * 4);
  });

  it("propagates inference errors without swallowing them", async () => {
    const release = vi.fn();
    const session: AiInferenceSession = {
      run: vi.fn(async () => {
        throw new Error("boom");
      }),
      release,
    };

    await expect(aiUpscale(session, imageData(1, 1), { factor: 2, nativeFactor: 4 }))
      .rejects.toThrow("boom");
    // release is the loader's concern, not the pure dispatch's.
    expect(release).not.toHaveBeenCalled();
  });
});

/** An RGBA image whose every pixel encodes its own coordinates (so a mis-placed
 *  tile would produce a visible, assertable discontinuity). Fully opaque. */
function coordImage(w: number, h: number): ImageData {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x * 7 + y * 13) & 255;
      data[i + 1] = (x * 3 + y * 29) & 255;
      data[i + 2] = (x * 17 + y * 5) & 255;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

/** A deterministic stub session that upscales the input tensor by `scale` with
 *  nearest-neighbour replication. Because NN is a purely local op, a correctly
 *  padded+cropped tiling must reproduce the whole-image result exactly. */
function nearestNeighborSession(scale: number): AiInferenceSession {
  return {
    run: vi.fn(async (feeds: Record<string, unknown>) => {
      const inp = feeds[REAL_ESRGAN_INPUT] as NchwTensor;
      const { width: w, height: h, data } = inp;
      const ow = w * scale;
      const oh = h * scale;
      const inPlane = w * h;
      const outPlane = ow * oh;
      const out = new Float32Array(3 * outPlane);
      for (let c = 0; c < 3; c++) {
        for (let oy = 0; oy < oh; oy++) {
          const sy = Math.floor(oy / scale);
          for (let ox = 0; ox < ow; ox++) {
            const sx = Math.floor(ox / scale);
            out[c * outPlane + oy * ow + ox] = data[c * inPlane + sy * w + sx];
          }
        }
      }
      return { [REAL_ESRGAN_OUTPUT]: { data: out, width: ow, height: oh } };
    }),
    release: vi.fn(),
  };
}

describe("planTiles", () => {
  it("covers the image with abutting cores and no gaps or overlaps", () => {
    const w = 40;
    const h = 24;
    const plans = planTiles(w, h, 16, 4);
    expect(plans).toHaveLength(6); // ceil(40/16)=3 cols × ceil(24/16)=2 rows

    // Cores exactly tile the image: total core area === image area.
    const area = plans.reduce((s, p) => s + p.core.width * p.core.height, 0);
    expect(area).toBe(w * h);

    for (const { core, padded } of plans) {
      // Core within bounds.
      expect(core.x + core.width).toBeLessThanOrEqual(w);
      expect(core.y + core.height).toBeLessThanOrEqual(h);
      // Padded contains the core and stays within the image.
      expect(padded.x).toBeLessThanOrEqual(core.x);
      expect(padded.y).toBeLessThanOrEqual(core.y);
      expect(padded.x + padded.width).toBeGreaterThanOrEqual(core.x + core.width);
      expect(padded.y + padded.height).toBeGreaterThanOrEqual(core.y + core.height);
      expect(padded.x).toBeGreaterThanOrEqual(0);
      expect(padded.y).toBeGreaterThanOrEqual(0);
      expect(padded.x + padded.width).toBeLessThanOrEqual(w);
      expect(padded.y + padded.height).toBeLessThanOrEqual(h);
    }

    // Top-left tile's padding is clamped at the image origin.
    expect(plans[0].padded.x).toBe(0);
    expect(plans[0].padded.y).toBe(0);
  });

  it("returns a single tile when the image fits within one tile", () => {
    expect(planTiles(100, 80, 256, 16)).toHaveLength(1);
  });
});

describe("aiUpscale — tiling (issue #44)", () => {
  it("runs one inference per tile for a large image", async () => {
    const session = nearestNeighborSession(4);
    // 40×24 with 16px tiles ⇒ 3×2 = 6 tiles.
    await aiUpscale(session, coordImage(40, 24), {
      factor: 4,
      nativeFactor: 4,
      tile: { size: 16, padding: 4 },
    });
    expect(session.run).toHaveBeenCalledTimes(6);
  });

  it("stitches tiles seam-free: tiled output equals the whole-image reference", async () => {
    const src = coordImage(40, 24);

    // Reference: force the single-inference path with an oversized tile.
    const ref = await aiUpscale(nearestNeighborSession(4), src, {
      factor: 4,
      nativeFactor: 4,
      tile: { size: 4096, padding: 16 },
    });

    // Tiled: many small tiles with overlap.
    const tiled = await aiUpscale(nearestNeighborSession(4), src, {
      factor: 4,
      nativeFactor: 4,
      tile: { size: 16, padding: 4 },
    });

    expect(tiled.width).toBe(ref.width);
    expect(tiled.height).toBe(ref.height);
    expect(tiled.data).toEqual(ref.data); // byte-identical ⇒ no seams
  });

  it("lands on an exact target size on the tiled path", async () => {
    const out = await aiUpscale(nearestNeighborSession(4), coordImage(50, 30), {
      factor: 4,
      nativeFactor: 4,
      exactTargetSize: { width: 123, height: 74 },
      tile: { size: 16, padding: 4 },
    });
    expect(out.width).toBe(123);
    expect(out.height).toBe(74);
    expect(out.data).toHaveLength(123 * 74 * 4);
  });

  it("reports per-tile progress in order", async () => {
    const seen: Array<[number, number]> = [];
    await aiUpscale(nearestNeighborSession(4), coordImage(40, 24), {
      factor: 4,
      nativeFactor: 4,
      tile: { size: 16, padding: 4 },
      onTileProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([
      [1, 6],
      [2, 6],
      [3, 6],
      [4, 6],
      [5, 6],
      [6, 6],
    ]);
  });
});

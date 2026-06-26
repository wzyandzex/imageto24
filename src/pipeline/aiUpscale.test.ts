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

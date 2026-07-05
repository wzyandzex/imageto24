// @vitest-environment node
//
// Pure APNG chunk-parser + compositor tests (issue #37).
//
// `decodeApngFrames` is pure: it walks APNG chunks, reconstructs per-frame PNG
// byte streams, and composites them onto a full canvas honouring blend + dispose.
// The actual PNG bitmap decode is injected (`decodePng`), so these tests run in
// plain Node — no browser, no pngjs. We assert the APNG semantics the parser
// owns: chunk walking, fcTL/fdAT reconstruction, delay conversion, blend (over
// vs source), and disposal (none/background/previous).
import { describe, expect, it } from "vitest";
import { decodeApngFrames } from "./apngParser";
import type { ImageData } from "../types";

/* -------------------------------------------------------------------------- */
/* PNG chunk helpers (mirror the e2e fixture builders)                         */
/* -------------------------------------------------------------------------- */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function be16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function crc32(buf: Uint8Array): number {
  let table: number[] | undefined = (crc32 as unknown as { table?: number[] }).table;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { table?: number[] }).table = table;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(Uint8Array.from([...typeBytes, ...data]));
  return [...be32(data.length), ...typeBytes, ...data, ...be32(crc)];
}

function ihdr(width: number, height: number): number[] {
  // 8-bit RGBA (colour type 6)
  return chunk("IHDR", [
    ...be32(width),
    ...be32(height),
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
}

function actl(numFrames: number, numPlays = 0): number[] {
  return chunk("acTL", [...be32(numFrames), ...be32(numPlays)]);
}

function fctl(
  seq: number,
  width: number,
  height: number,
  xOffset: number,
  yOffset: number,
  delayNum: number,
  delayDen: number,
  disposeOp: number,
  blendOp: number,
): number[] {
  return chunk("fcTL", [
    ...be32(seq),
    ...be32(width),
    ...be32(height),
    ...be32(xOffset),
    ...be32(yOffset),
    ...be16(delayNum),
    ...be16(delayDen),
    disposeOp,
    blendOp,
  ]);
}

function idat(payload: number[]): number[] {
  return chunk("IDAT", payload);
}

function fdat(seq: number, payload: number[]): number[] {
  return chunk("fdAT", [...be32(seq), ...payload]);
}

const IEND = chunk("IEND", []);

/** Build an APNG byte array from the given chunk list (PNG sig prepended). */
function buildApng(...chunks: number[][]): ArrayBuffer {
  return new Uint8Array([...PNG_SIG, ...chunks.flat()]).buffer;
}

/* -------------------------------------------------------------------------- */
/* decodePng stub: returns a full-canvas-opaque patch of one solid colour,    */
/* sized to whatever fcTL the parser passed (read from the rebuilt IHDR).    */
/* -------------------------------------------------------------------------- */

/** A naive inflate: the parser passes pre-decompressed IDAT bytes, so "decode" */
/* just interprets the parser's rebuilt PNG. For tests we return a solid-colour */
/* patch sized to the frame's fcTL — the parser validates dimensions itself.   */
function solidPatchDecoderFactory(
  colourByWidth: Record<number, [number, number, number, number]>,
) {
  return async (png: ArrayBuffer): Promise<ImageData> => {
    const bytes = new Uint8Array(png);
    // Read width/height from the rebuilt IHDR (the only IHDR in the stream).
    let width = 0;
    let height = 0;
    for (let pos = 8; pos + 8 <= bytes.length; ) {
      const len = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (type === "IHDR") {
        width = (bytes[pos + 8] << 24 | bytes[pos + 9] << 16 | bytes[pos + 10] << 8 | bytes[pos + 11]) >>> 0;
        height = (bytes[pos + 12] << 24 | bytes[pos + 13] << 16 | bytes[pos + 14] << 8 | bytes[pos + 15]) >>> 0;
        break;
      }
      pos += 8 + len + 4;
    }
    const [r, g, b, a] = colourByWidth[width] ?? [0, 0, 0, 255];
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
    return { width, height, data };
  };
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("apngParser — chunk walking + frame reconstruction (issue #37)", () => {
  it("decodes a 2-frame APNG into two full-canvas frames", async () => {
    // 4×4 canvas, two full-canvas frames. fdat payloads are opaque to the
    // parser (it just re-wraps them into per-frame PNGs); the stub decoder
    // returns a solid colour keyed off the rebuilt IHDR width.
    const apng = buildApng(
      ihdr(4, 4),
      actl(2),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0),
      fdat(1, [0xaa]),
      fctl(2, 4, 4, 0, 0, 20, 100, 0, 0),
      fdat(3, [0xbb]),
      IEND,
    );

    const frames = await decodeApngFrames(
      apng,
      solidPatchDecoderFactory({ 4: [10, 20, 30, 255] }),
    );

    expect(frames).toHaveLength(2);
    expect(frames[0].imageData.width).toBe(4);
    expect(frames[0].imageData.height).toBe(4);
    // Distinct delays (10/100s = 100ms, 20/100s = 200ms).
    expect(frames.map((f) => f.delay)).toEqual([100, 200]);
  });

  it("throws an honest error when the PNG signature is missing", async () => {
    await expect(
      decodeApngFrames(new Uint8Array([0x00, 0x01, 0x02]).buffer, async () => ({
        width: 1, height: 1, data: new Uint8ClampedArray(4),
      })),
    ).rejects.toThrow(/invalid PNG signature/i);
  });

  it("throws when acTL is missing (still PNG, not an APNG)", async () => {
    const apng = buildApng(ihdr(4, 4), idat([0x00]), IEND);
    await expect(
      decodeApngFrames(apng, async () => ({
        width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4),
      })),
    ). rejects.toThrow(/acTL/i);
  });

  it("throws when a frame has no image data (fdAT missing)", async () => {
    const apng = buildApng(
      ihdr(4, 4),
      actl(1),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0),
      // No fdAT/IDAT for this frame.
      IEND,
    );
    await expect(
      decodeApngFrames(apng, async () => ({
        width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4),
      })),
    ).rejects.toThrow(/no image data/i);
  });

  it("rejects a frame whose decoded dimensions do not match fcTL", async () => {
    const apng = buildApng(
      ihdr(4, 4),
      actl(1),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0),
      fdat(1, [0xaa]),
      IEND,
    );
    // Decoder returns wrong size — the parser must catch the mismatch.
    await expect(
      decodeApngFrames(apng, async () => ({
        width: 2, height: 2, data: new Uint8ClampedArray(2 * 2 * 4),
      })),
    ).rejects.toThrow(/dimensions did not match fcTL/i);
  });
});

describe("apngParser — sub-frame compositing + blend (APNG_BLEND_OP_OVER)", () => {
  it("places a sub-rect frame at its fcTL xOffset/yOffset", async () => {
    // 4×4 canvas, frame 0 fills it; frame 1 is a 2×2 sub-rect at (1,1).
    const apng = buildApng(
      ihdr(4, 4),
      actl(2),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0), // dispose none, blend source
      fdat(1, [0xaa]),
      fctl(2, 2, 2, 1, 1, 20, 100, 0, 0), // 2×2 at offset (1,1)
      fdat(3, [0xbb]),
      IEND,
    );
    // Frame 0 → red; frame 1 (2×2) → green.
    const decode = solidPatchDecoderFactory({
      4: [255, 0, 0, 255],
      2: [0, 255, 0, 255],
    });

    const frames = await decodeApngFrames(apng, decode);
    // Frame 0 fully red.
    const f0 = frames[0].imageData.data;
    expect([f0[0], f0[1], f0[2], f0[3]]).toEqual([255, 0, 0, 255]);

    // Frame 1: the 2×2 green patch over the red background at (1,1). With blend
    // SOURCE the patch fully overwrites. Corners stay red; the inner 2×2 is green.
    const f1 = frames[1].imageData.data;
    const at = (x: number, y: number) => {
      const i = (y * 4 + x) * 4;
      return [f1[i], f1[i + 1], f1[i + 2], f1[i + 3]];
    };
    expect(at(0, 0)).toEqual([255, 0, 0, 255]); // outside patch
    expect(at(1, 1)).toEqual([0, 255, 0, 255]); // inside patch
    expect(at(2, 2)).toEqual([0, 255, 0, 255]); // inside patch
    expect(at(3, 3)).toEqual([255, 0, 0, 255]); // outside patch
  });

  it("APNG_BLEND_OP_OVER alpha-composites a semi-transparent patch over the canvas", async () => {
    // Frame 0: opaque black. Frame 1: 4×4 patch at 50% white, blend OVER.
    const apng = buildApng(
      ihdr(4, 4),
      actl(2),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0),
      fdat(1, [0xaa]),
      fctl(2, 4, 4, 0, 0, 20, 100, 0, 1), // blendOp = 1 (OVER)
      fdat(3, [0xbb]),
      IEND,
    );
    // Both frames use width 4, so use distinct decoder results per call:
    // frame 0 opaque black, frame 1 50% white.
    let call = 0;
    const decodeSeq: ImageData[] = [
      { width: 4, height: 4, data: solid(4, 4, 0, 0, 0, 255) },
      { width: 4, height: 4, data: solid(4, 4, 255, 255, 255, 128) },
    ];
    const frames = await decodeApngFrames(apng, async () => decodeSeq[call++]);

    // Frame 0: opaque black.
    const f0 = frames[0].imageData.data;
    expect([f0[0], f0[1], f0[2], f0[3]]).toEqual([0, 0, 0, 255]);

    // Frame 1: 50% white OVER opaque black → grey (~128), alpha stays 255.
    const f1 = frames[1].imageData.data;
    expect(f1[3]).toBe(255); // opaque composite
    expect(f1[0]).toBeGreaterThan(100);
    expect(f1[0]).toBeLessThan(156);
  });
});

describe("apngParser — disposal ops (none / background / previous)", () => {
  it("APNG_DISPOSE_OP_BACKGROUND clears the frame's rect for the next frame", async () => {
    // Frame 0: full-canvas red, dispose BACKGROUND. Frame 1: 1×1 at (0,0) blue.
    // After disposal, the canvas is cleared where frame 0 painted (all of it),
    // so frame 1's full-canvas snapshot should show transparent everywhere
    // except the 1×1 blue patch at (0,0).
    const apng = buildApng(
      ihdr(4, 4),
      actl(2),
      fctl(0, 4, 4, 0, 0, 10, 100, 1, 0), // dispose BACKGROUND
      fdat(1, [0xaa]),
      fctl(2, 1, 1, 0, 0, 20, 100, 0, 0), // 1×1 at (0,0), dispose none
      fdat(3, [0xbb]),
      IEND,
    );
    let call = 0;
    const decodeSeq: ImageData[] = [
      { width: 4, height: 4, data: solid(4, 4, 255, 0, 0, 255) },
      { width: 1, height: 1, data: solid(1, 1, 0, 0, 255, 255) },
    ];
    const frames = await decodeApngFrames(apng, async () => decodeSeq[call++]);

    // Frame 0 snapshot: all red (snapshot taken before disposal).
    const f0 = frames[0].imageData.data;
    expect([f0[0], f0[1], f0[2], f0[3]]).toEqual([255, 0, 0, 255]);

    // Frame 1 snapshot: blue at (0,0), transparent elsewhere (background cleared).
    const f1 = frames[1].imageData.data;
    const at = (x: number, y: number) => {
      const i = (y * 4 + x) * 4;
      return [f1[i], f1[i + 1], f1[i + 2], f1[i + 3]];
    };
    expect(at(0, 0)).toEqual([0, 0, 255, 255]);
    expect(at(1, 0)).toEqual([0, 0, 0, 0]); // cleared to background
  });

  it("APNG_DISPOSE_OP_PREVIOUS restores the pre-frame canvas for the next frame", async () => {
    // Frame 0: full-canvas red, dispose NONE (so red persists). Frame 1: full
    // canvas green, dispose NONE — but its *snapshot* is green. Frame 2: 1×1 at
    // (0,0) blue, dispose NONE. The point: with no PREVIOUS disposal the canvas
    // just accumulates; with PREVIOUS on frame 1, the canvas would restore to
    // red before frame 2 composites. We test PREVIOUS on frame 1 here.
    const apng = buildApng(
      ihdr(4, 4),
      actl(3),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0), // frame 0: red, dispose none
      fdat(1, [0xaa]),
      fctl(2, 4, 4, 0, 0, 20, 100, 2, 0), // frame 1: green, dispose PREVIOUS
      fdat(3, [0xcc]),
      fctl(4, 1, 1, 0, 0, 30, 100, 0, 0), // frame 2: 1×1 blue at (0,0)
      fdat(5, [0xdd]),
      IEND,
    );
    let call = 0;
    const decodeSeq: ImageData[] = [
      { width: 4, height: 4, data: solid(4, 4, 255, 0, 0, 255) },
      { width: 4, height: 4, data: solid(4, 4, 0, 255, 0, 255) },
      { width: 1, height: 1, data: solid(1, 1, 0, 0, 255, 255) },
    ];
    const frames = await decodeApngFrames(apng, async () => decodeSeq[call++]);

    // Frame 1 snapshot: green (taken before disposal).
    const f1 = frames[1].imageData.data;
    expect([f1[0], f1[1], f1[2], f1[3]]).toEqual([0, 255, 0, 255]);

    // Frame 2: disposal PREVIOUS on frame 1 restored the canvas to red (frame 0's
    // state). Then frame 2's blue 1×1 composites at (0,0). So (0,0)=blue, rest=red.
    const f2 = frames[2].imageData.data;
    const at = (x: number, y: number) => {
      const i = (y * 4 + x) * 4;
      return [f2[i], f2[i + 1], f2[i + 2], f2[i + 3]];
    };
    expect(at(0, 0)).toEqual([0, 0, 255, 255]); // frame 2's patch
    expect(at(1, 0)).toEqual([255, 0, 0, 255]); // restored from frame 0
  });

  it("APNG_DISPOSE_OP_NONE leaves the canvas as-is for the next frame", async () => {
    // Frame 0: red, dispose NONE. Frame 1: 1×1 blue at (0,0), dispose NONE.
    // The canvas retains red everywhere; blue overwrites only (0,0).
    const apng = buildApng(
      ihdr(4, 4),
      actl(2),
      fctl(0, 4, 4, 0, 0, 10, 100, 0, 0),
      fdat(1, [0xaa]),
      fctl(2, 1, 1, 0, 0, 20, 100, 0, 0),
      fdat(3, [0xbb]),
      IEND,
    );
    let call = 0;
    const decodeSeq: ImageData[] = [
      { width: 4, height: 4, data: solid(4, 4, 255, 0, 0, 255) },
      { width: 1, height: 1, data: solid(1, 1, 0, 0, 255, 255) },
    ];
    const frames = await decodeApngFrames(apng, async () => decodeSeq[call++]);

    const f1 = frames[1].imageData.data;
    const at = (x: number, y: number) => {
      const i = (y * 4 + x) * 4;
      return [f1[i], f1[i + 1], f1[i + 2], f1[i + 3]];
    };
    expect(at(0, 0)).toEqual([0, 0, 255, 255]);
    expect(at(1, 0)).toEqual([255, 0, 0, 255]); // red persists (dispose none)
  });
});

describe("apngParser — delay conversion + disposalType mapping", () => {
  it("converts fcTL delay_num/delay_den to milliseconds (default den 100)", async () => {
    const apng = buildApng(
      ihdr(4, 4),
      actl(1),
      fctl(0, 4, 4, 0, 0, 50, 100, 0, 0), // 50/100s = 500ms
      fdat(1, [0xaa]),
      IEND,
    );
    const frames = await decodeApngFrames(apng, async () => ({
      width: 4, height: 4, data: solid(4, 4, 0, 0, 0, 255),
    }));
    expect(frames[0].delay).toBe(500);
  });

  it("honours a non-100 delay denominator (e.g. 1000 → ms-precision)", async () => {
    const apng = buildApng(
      ihdr(4, 4),
      actl(1),
      fctl(0, 4, 4, 0, 0, 33, 1000, 0, 0), // 33/1000s = 33ms
      fdat(1, [0xaa]),
      IEND,
    );
    const frames = await decodeApngFrames(apng, async () => ({
      width: 4, height: 4, data: solid(4, 4, 0, 0, 0, 255),
    }));
    expect(frames[0].delay).toBe(33);
  });

  it("maps APNG dispose previous (2) to GIF disposalType 3 for re-encode fidelity", async () => {
    const apng = buildApng(
      ihdr(4, 4),
      actl(1),
      fctl(0, 4, 4, 0, 0, 10, 100, 2, 0), // dispose PREVIOUS
      fdat(1, [0xaa]),
      IEND,
    );
    const frames = await decodeApngFrames(apng, async () => ({
      width: 4, height: 4, data: solid(4, 4, 0, 0, 0, 255),
    }));
    expect(frames[0].disposalType).toBe(3);
  });
});

/* helpers ----------------------------------------------------------------- */

function solid(
  w: number, h: number,
  r: number, g: number, b: number, a: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return data;
}

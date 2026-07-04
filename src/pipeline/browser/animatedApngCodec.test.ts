// @vitest-environment jsdom
//
// Animated-APNG codec contract tests (issues #27 / #37). The codec is bound to
// browser/WebCodecs, UPNG.js, and pngjs, so the tests stub those dependencies and
// assert the adapter contract:
//
//  - decoder WebCodecs path: ImageDecoder is used when available, every frame is
//    decoded in order, read back, delay is converted from µs to ms, resources close.
//  - decoder fallback path: without ImageDecoder, pngjs is lazy-loaded and the
//    self-built APNG parser yields full-canvas composited frames.
//  - encoder path: UPNG receives one copied RGBA buffer per frame, delays in order,
//    and `cnum === 0` for true-colour APNG output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImageData } from "../types";

interface CapturedEncodeCall {
  imgs: ArrayBuffer[];
  width: number;
  height: number;
  cnum: number;
  delays?: number[];
}

const encodeCalls: CapturedEncodeCall[] = [];
const PNG_READ_CALLS: Buffer[] = [];
const ENCODE_RESULT = new ArrayBuffer(64);
let pngReadResults: Array<{ width: number; height: number; data: Buffer }> = [];

vi.mock("upng-js", () => ({
  default: {
    encode: (
      imgs: ArrayBuffer[],
      width: number,
      height: number,
      cnum: number,
      delays?: number[],
    ) => {
      encodeCalls.push({ imgs, width, height, cnum, delays });
      return ENCODE_RESULT;
    },
  },
}));

vi.mock("pngjs/browser", () => ({
  PNG: {
    sync: {
      read: (buffer: Buffer) => {
        PNG_READ_CALLS.push(buffer);
        const result = pngReadResults.shift();
        if (!result) throw new Error("pngjs read called too many times");
        return result;
      },
    },
  },
}));

import {
  browserAnimatedApngDecoder,
  browserAnimatedApngEncoder,
} from "./animatedApngCodec";

function ensureImageDataGlobal() {
  if (typeof globalThis.ImageData === "undefined") {
    (globalThis as unknown as { ImageData: unknown }).ImageData = class {
      width: number;
      height: number;
      data: Uint8ClampedArray;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.width = width;
        this.height = height;
        this.data = data;
      }
    };
  }
}

function stubImageDecoder(frameCount: number) {
  const decodeCalls: number[] = [];
  const closedFrames: number[] = [];
  let decoderClosed = false;
  let forcedError: Error | undefined;

  const fakeVideoFrame = (index: number) => ({
    duration: (100 + index * 50) * 1000,
    timestamp: index * 100_000,
    codedWidth: 4,
    codedHeight: 4,
    close: () => closedFrames.push(index),
  });

  const fakeDecoder = {
    tracks: {
      ready: Promise.resolve(),
      selectedTrack: { frameCount, type: "animated" as const },
    },
    decode: vi.fn(async ({ frameIndex }: { frameIndex: number }) => {
      decodeCalls.push(frameIndex);
      if (forcedError) throw forcedError;
      return { image: fakeVideoFrame(frameIndex) };
    }),
    close: () => {
      decoderClosed = true;
    },
  };

  (globalThis as unknown as { ImageDecoder: unknown }).ImageDecoder = vi.fn(
    () => fakeDecoder,
  ) as unknown as typeof ImageDecoder;

  const fakeCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const index = decodeCalls.length - 1;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) data[i] = index * 20;
      return { width: w, height: h, data };
    }),
  };
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = vi.fn(
    (width: number, height: number) => ({
      width,
      height,
      getContext: () => fakeCtx,
    }),
  ) as unknown as typeof OffscreenCanvas;

  return {
    decodeCalls,
    closedFrames,
    isDecoderClosed: () => decoderClosed,
    forceDecodeError: (err: Error) => {
      forcedError = err;
    },
  };
}

function frame(r: number, g: number, b: number, a = 255): ImageData {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: 2, height: 2, data };
}

const FRAMES = [
  { imageData: frame(10, 20, 30), delay: 100, disposalType: 1 },
  { imageData: frame(200, 100, 50), delay: 150, disposalType: 1 },
  { imageData: frame(0, 0, 0, 0), delay: 200, disposalType: 1 },
];

beforeEach(() => {
  encodeCalls.length = 0;
  PNG_READ_CALLS.length = 0;
  pngReadResults = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder;
});

describe("browserAnimatedApngDecoder — WebCodecs path (issue #37)", () => {
  it("decodes every APNG frame in order and surfaces delay + full-canvas pixels", async () => {
    ensureImageDataGlobal();
    const spies = stubImageDecoder(3);

    const frames = await browserAnimatedApngDecoder.decodeAnimated(
      new ArrayBuffer(16),
      "apng",
    );

    expect(spies.decodeCalls).toEqual([0, 1, 2]);
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.delay)).toEqual([100, 150, 200]);
    expect(frames.every((f) => f.disposalType === 1)).toBe(true);
    expect(frames[1].imageData.data[0]).toBe(20);
    expect(spies.closedFrames).toEqual([0, 1, 2]);
    expect(spies.isDecoderClosed()).toBe(true);
  });

  it("throws an honest error when ImageDecoder reports no frames", async () => {
    ensureImageDataGlobal();
    stubImageDecoder(0);

    await expect(
      browserAnimatedApngDecoder.decodeAnimated(new ArrayBuffer(8), "apng"),
    ).rejects.toThrow(/no frames/i);
  });

  it("wraps a malformed APNG decode rejection in a user-facing error", async () => {
    ensureImageDataGlobal();
    const spies = stubImageDecoder(2);
    spies.forceDecodeError(new Error("boom"));

    await expect(
      browserAnimatedApngDecoder.decodeAnimated(new ArrayBuffer(8), "apng"),
    ).rejects.toThrow(/could not be parsed or decoded/i);
    expect(spies.isDecoderClosed()).toBe(true);
  });
});

describe("browserAnimatedApngDecoder — pngjs fallback (issue #37)", () => {
  it("lazy-loads pngjs and decodes an APNG through the self-built parser when WebCodecs is unavailable", async () => {
    ensureImageDataGlobal();
    expect(typeof ImageDecoder).toBe("undefined");
    pngReadResults = [
      { width: 2, height: 2, data: Buffer.from(solid(2, 2, 255, 0, 0, 255)) },
      { width: 1, height: 1, data: Buffer.from(solid(1, 1, 0, 0, 255, 255)) },
    ];

    const frames = await browserAnimatedApngDecoder.decodeAnimated(
      buildFallbackApng(),
      "apng",
    );

    expect(PNG_READ_CALLS).toHaveLength(2);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.delay)).toEqual([100, 200]);
    expect(frames[0].imageData.width).toBe(2);
    expect(frames[0].imageData.height).toBe(2);
    const f1 = frames[1].imageData.data;
    expect([f1[0], f1[1], f1[2], f1[3]]).toEqual([0, 0, 255, 255]);
    expect([f1[4], f1[5], f1[6], f1[7]]).toEqual([255, 0, 0, 255]);
  });

  it("surfaces malformed fallback input as an APNG decode error", async () => {
    ensureImageDataGlobal();
    await expect(
      browserAnimatedApngDecoder.decodeAnimated(new Uint8Array([0, 1, 2]).buffer, "apng"),
    ).rejects.toThrow(/APNG decode/i);
  });
});

describe("browserAnimatedApngEncoder (issue #27)", () => {
  it("lazy-imports upng-js on first APNG output and calls encode once", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, { width: 2, height: 2 });
    expect(encodeCalls).toHaveLength(1);
  });

  it("passes one RGBA buffer per frame, in frame order, copied from imageData.data", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, { width: 2, height: 2 });

    const [call] = encodeCalls;
    expect(call.imgs).toHaveLength(3);
    expect([...new Uint8Array(call.imgs[0]).slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...new Uint8Array(call.imgs[1]).slice(0, 4)]).toEqual([200, 100, 50, 255]);
    expect([...new Uint8Array(call.imgs[2]).slice(0, 4)]).toEqual([0, 0, 0, 0]);
  });

  it("does not alias the caller's frame buffers — each is an independent copy", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, { width: 2, height: 2 });

    const [call] = encodeCalls;
    const captured = new Uint8Array(call.imgs[0]);
    captured[0] = 255;
    expect(FRAMES[0].imageData.data[0]).toBe(10);
  });

  it("uses cnum: 0 — true-colour, NO 256-colour quantization", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, { width: 2, height: 2 });
    expect(encodeCalls[0].cnum).toBe(0);
  });

  it("forwards per-frame delays in frame order, in milliseconds", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, { width: 2, height: 2 });
    expect(encodeCalls[0].delays).toEqual([100, 150, 200]);
  });

  it("forwards the canvas width/height", async () => {
    await browserAnimatedApngEncoder.encodeAnimated(FRAMES, { width: 4, height: 6 });
    expect(encodeCalls[0].width).toBe(4);
    expect(encodeCalls[0].height).toBe(6);
  });

  it("returns UPNG's encoded ArrayBuffer verbatim", async () => {
    const out = await browserAnimatedApngEncoder.encodeAnimated(FRAMES, {
      width: 2,
      height: 2,
    });

    expect(out).toBe(ENCODE_RESULT);
    expect(encodeCalls).toHaveLength(1);
  });
});

/* APNG fixture helpers ----------------------------------------------------- */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IEND = chunk("IEND", []);

function buildFallbackApng(): ArrayBuffer {
  return new Uint8Array([
    ...PNG_SIG,
    ...ihdr(2, 2),
    ...chunk("acTL", [...be32(2), ...be32(0)]),
    ...fctl(0, 2, 2, 0, 0, 10, 100, 0, 0),
    ...fdat(1, [0xaa]),
    ...fctl(2, 1, 1, 0, 0, 20, 100, 0, 0),
    ...fdat(3, [0xbb]),
    ...IEND,
  ]).buffer;
}

function ihdr(width: number, height: number): number[] {
  return chunk("IHDR", [
    ...be32(width),
    ...be32(height),
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
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

function fdat(seq: number, payload: number[]): number[] {
  return chunk("fdAT", [...be32(seq), ...payload]);
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0));
  const crc = crc32(Uint8Array.from([...typeBytes, ...data]));
  return [...be32(data.length), ...typeBytes, ...data, ...be32(crc)];
}

function be16(n: number): number[] {
  return [(n >>> 8) & 0xff, n & 0xff];
}

function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
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

function solid(
  w: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
): Uint8Array {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

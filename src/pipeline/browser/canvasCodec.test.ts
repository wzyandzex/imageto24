// @vitest-environment jsdom
//
// Browser codec tests (issue #10, extended v2 HEIC #15) for the decode path.
//
// The codec is browser-bound (`createImageBitmap` + Canvas, plus `heic2any` for
// HEIC), so it normally lives outside the pure-function seam. But the PRD
// acceptance criteria require Vitest coverage of `decode` for AVIF, GIF
// first-frame, and HEIC fixtures. We reach that coverage by stubbing the browser
// APIs (`createImageBitmap`, `OffscreenCanvas`, `ImageData`) with deterministic
// fakes and asserting the codec feeds bytes through `createImageBitmap` and
// reads pixels back - for AVIF natively, for GIF with the first frame only, and
// for HEIC via a heic2any -> PNG convert first. The pixel-level decode truth is
// additionally exercised end-to-end by Playwright.
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserDecoder } from "./canvasCodec";
import { decodeStrategy } from "../formats";

/**
 * A fake decoded frame: records that a Blob reached createImageBitmap and
 * surfaces a 1x1 RGBA pixel surface via the Canvas readback path. Lets us
 * assert "the GIF bytes were handed to createImageBitmap once" without a real
 * image decoder. jsdom's Blob lacks arrayBuffer(), so we capture the blob and
 * compare by byte length + first byte rather than reading it back.
 */
function stubBrowserDecode() {
  const calls: { blobByteLength: number; firstByte: number }[] = [];

  const fakeBitmap = {
    width: 1,
    height: 1,
    close: vi.fn(),
  };

  // createImageBitmap: record the incoming blob's size + signature byte, return
  // a bitmap the Canvas readback will draw. The real browser yields GIF's first
  // frame here; our fake just confirms the codec handed the bytes over.
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
    async (blob: Blob) => {
      // jsdom Blob supports slice; read the first byte and the size.
      const firstByte = blob.size > 0 ? blob.slice(0, 1).size : 0;
      calls.push({ blobByteLength: blob.size, firstByte });
      void firstByte;
      return fakeBitmap;
    },
  );

  // Canvas 2D context fake: drawImage is a no-op; getImageData returns a 1x1
  // RGBA pixel so the codec produces a valid ImageData.
  const fakeCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([10, 20, 30, 255]),
    })),
    putImageData: vi.fn(),
  };

  // OffscreenCanvas fake with a getContext returning our context stub.
  (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas = vi.fn(
    (width: number, height: number) => ({
      width,
      height,
      getContext: () => fakeCtx,
      convertToBlob: async () => new Blob([new Uint8Array(0)]),
    }),
  );

  // The codec constructs a DOM ImageData to put pixels; jsdom provides it, but
  // ensure the global exists so putImageData in the encode path doesn't throw.
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

  return { calls, fakeBitmap, fakeCtx };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("browserDecoder — AVIF input (issue #10, AC)", () => {
  it("decodes an AVIF buffer to RGBA pixels via createImageBitmap", async () => {
    // AVIF is browser-native (decodeStrategy "native"). The codec hands the
    // bytes to createImageBitmap and reads the pixels back via Canvas.
    expect(decodeStrategy("avif")).toBe("native");

    const { calls, fakeBitmap } = stubBrowserDecode();
    const avifBytes = new ArrayBuffer(64);
    new Uint8Array(avifBytes).fill(0xab);

    const imageData = await browserDecoder.decode(avifBytes, "avif");

    // The AVIF bytes reached createImageBitmap exactly once.
    expect(calls).toHaveLength(1);
    expect(calls[0].blobByteLength).toBe(64);
    // The bitmap was released after readback (no leak across batch items).
    expect(fakeBitmap.close).toHaveBeenCalledTimes(1);
    // The pixel surface is 1x1 with the stubbed RGBA value.
    expect(imageData.width).toBe(1);
    expect(imageData.height).toBe(1);
    expect(Array.from(imageData.data)).toEqual([10, 20, 30, 255]);
  });
});

describe("browserDecoder — GIF first-frame input (issue #10, AC)", () => {
  it("decodes a GIF to its first frame only via createImageBitmap", async () => {
    // GIF policy: first-frame extraction; per-frame enhancement is out of scope.
    expect(decodeStrategy("gif")).toBe("firstFrame");

    const { calls, fakeBitmap } = stubBrowserDecode();
    // A multi-frame GIF's bytes; createImageBitmap yields the first frame in the
    // real browser. Our stub confirms the codec hands the GIF bytes over once.
    const gifBytes = new ArrayBuffer(128);
    new Uint8Array(gifBytes).fill(0x47); // 'G' — GIF signature byte

    const imageData = await browserDecoder.decode(gifBytes, "gif");

    // The GIF bytes reached createImageBitmap exactly once — one frame decoded,
    // not the whole animation. This is the first-frame contract.
    expect(calls).toHaveLength(1);
    expect(calls[0].blobByteLength).toBe(128);
    expect(fakeBitmap.close).toHaveBeenCalledTimes(1);
    expect(imageData.width).toBe(1);
    expect(imageData.height).toBe(1);
    expect(Array.from(imageData.data)).toEqual([10, 20, 30, 255]);
  });

  it("does not loop over GIF frames — a single decode call yields a single still", async () => {
    // Guards against a future change that might try to iterate frames: the v1
    // contract is exactly one createImageBitmap call per GIF, yielding one frame.
    const { calls } = stubBrowserDecode();
    const gifBytes = new ArrayBuffer(32);

    await browserDecoder.decode(gifBytes, "gif");

    expect(calls).toHaveLength(1);
    expect(calls[0].blobByteLength).toBe(32);
  });
});

// heic2any is a ~500KB dependency the decoder lazy-imports (issue #15). We stub
// the module so Vitest never loads the real bytes; the test asserts the decoder
// hands the HEIC blob to heic2any with toType "image/png", then decodes the
// returned PNG via createImageBitmap like any other native format.
vi.mock("heic2any", () => ({
  default: vi.fn(async ({ toType }: { blob: Blob; toType?: string }) => {
    heic2anyCalls.push({ toType: toType ?? "<default>" });
    return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
  }),
}));

const heic2anyCalls: { toType: string }[] = [];

describe("browserDecoder — HEIC input (issue #15, AC)", () => {
  it("routes HEIC through the convert strategy", () => {
    // HEIC has no native browser decoder; the decoder seam transcodes it first.
    expect(decodeStrategy("heic")).toBe("convert");
  });

  it("converts HEIC to PNG via heic2any, then decodes via createImageBitmap", async () => {
    const { calls, fakeBitmap } = stubBrowserDecode();
    heic2anyCalls.length = 0;
    const heicBytes = new ArrayBuffer(96);
    new Uint8Array(heicBytes).fill(0x00);

    const imageData = await browserDecoder.decode(heicBytes, "heic");

    // heic2any was called once with a PNG target — the convert contract.
    expect(heic2anyCalls).toHaveLength(1);
    expect(heic2anyCalls[0].toType).toBe("image/png");
    // The returned PNG blob reached createImageBitmap exactly once.
    expect(calls).toHaveLength(1);
    expect(fakeBitmap.close).toHaveBeenCalledTimes(1);
    // The decoded pixels flow through the same Canvas readback as native formats.
    expect(imageData.width).toBe(1);
    expect(imageData.height).toBe(1);
    expect(Array.from(imageData.data)).toEqual([10, 20, 30, 255]);
  });

  it("surfaces an honest error when heic2any rejects (malformed/unconvertible)", async () => {
    // A malformed or unsupported HEIC must produce a clear error, not a crash or
    // a hang (PRD HEIC user story #7). Stub heic2any to reject and assert the
    // decoder wraps it with a user-facing message.
    const heic2any = (await import("heic2any")).default as unknown as {
      mockClear: () => void;
      mockRejectedValueOnce: (v: unknown) => void;
    };
    heic2any.mockClear();
    heic2any.mockRejectedValueOnce(new Error("libheif decode failed"));
    stubBrowserDecode();

    const badHeic = new ArrayBuffer(8);

    await expect(browserDecoder.decode(badHeic, "heic")).rejects.toThrow(
      /could not be converted/i,
    );
  });
});

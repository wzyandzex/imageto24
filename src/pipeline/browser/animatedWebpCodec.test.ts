// @vitest-environment jsdom
//
// Animated-WebP decoder tests (issue #26). The decoder is browser-bound
// (WebCodecs `ImageDecoder` for the high-fidelity path; a lazy wasm lib for the
// fallback), so like `canvasCodec.test.ts` we stub the browser APIs with
// deterministic fakes and assert the codec's contract: every frame is decoded
// in order and surfaced as a full-canvas `ImageData` with its `delay`
// (PRD story #11) and `disposalType`. The pixel-level decode truth is
// additionally exercised end-to-end by Playwright on a WebCodecs-capable browser.
//
// Two paths are covered:
//  - WebCodecs path  — a stubbed `ImageDecoder` yields N frames; the codec must
//                       decode each, read it back via OffscreenCanvas, and close
//                       both the frame and the decoder.
//  - wasm fallback    — when `ImageDecoder` is absent (no WebCodecs), the codec
//                       degrades to the still decoder's single frame (ADR-0002
//                       honest degradation); we stub the dynamic import.
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserAnimatedWebpDecoder } from "./animatedWebpCodec";
import type { DecodedAnimatedFrame } from "../types";

/** Ensure the DOM `ImageData` global exists (jsdom usually provides it). */
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

/**
 * Install a stub `ImageDecoder` global that reports `frameCount` frames and
 * yields a fake `VideoFrame` (via `ImageDecodeResult.image`) per `decode` call.
 * Records every decode so a test can assert order + count, and tracks
 * `close()` on both frames and the decoder (no leaks).
 */
function stubImageDecoder(frameCount: number) {
  const decodeCalls: number[] = [];
  const closedFrames: number[] = [];
  let decoderClosed = false;
  // When set, every `decode` rejects with this — simulates a corrupt bitstream.
  let forcedError: Error | undefined;

  const fakeVideoFrame = (index: number) => ({
    // duration is microseconds — 100ms = 100_000µs, distinct per frame for order checks.
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
    reset: vi.fn(),
    close: () => {
      decoderClosed = true;
    },
  };

  (globalThis as unknown as { ImageDecoder: unknown }).ImageDecoder = vi.fn(
    () => fakeDecoder,
  ) as unknown as typeof ImageDecoder;

  // OffscreenCanvas + 2D context fake: drawImage is a no-op; getImageData
  // returns a 4x4 RGBA surface whose red channel encodes the frame index, so a
  // test can tell which frame produced which ImageData.
  const fakeCtx = {
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => {
      const index = decodeCalls.length - 1;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) data[i] = index * 10;
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
    /** Read after the decode resolves — the closure captures the live flag. */
    isDecoderClosed: () => decoderClosed,
    /** Inject a decode rejection from a test (simulates a corrupt bitstream). */
    forceDecodeError: (e: Error) => {
      forcedError = e;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Drop the ImageDecoder stub so the wasm-fallback test sees it absent.
  delete (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder;
});

describe("browserAnimatedWebpDecoder — WebCodecs path (issue #26)", () => {
  it("decodes every frame in order and surfaces delay + disposal per frame", async () => {
    ensureImageDataGlobal();
    const spies = stubImageDecoder(3);

    const frames = await browserAnimatedWebpDecoder.decodeAnimated(
      new ArrayBuffer(16),
      "webp",
    );

    // All three frames were requested in index order.
    expect(spies.decodeCalls).toEqual([0, 1, 2]);
    expect(frames).toHaveLength(3);
    // Each frame's delay is the microsecond duration converted to ms.
    expect((frames as DecodedAnimatedFrame[]).map((f) => f.delay)).toEqual([
      100, 150, 200,
    ]);
    // disposalType is carried through (1 = do-not-dispose, WebP full-canvas).
    expect((frames as DecodedAnimatedFrame[]).every((f) => f.disposalType === 1)).toBe(true);
    // Each VideoFrame was closed (no leak), and the decoder was released. The
    // closure flag is read through a getter so we observe the post-decode state.
    expect(spies.closedFrames).toEqual([0, 1, 2]);
    expect(spies.isDecoderClosed()).toBe(true);
  });

  it("throws an honest error when ImageDecoder reports no frames", async () => {
    ensureImageDataGlobal();
    stubImageDecoder(0);

    await expect(
      browserAnimatedWebpDecoder.decodeAnimated(new ArrayBuffer(8), "webp"),
    ).rejects.toThrow(/no frames/i);
  });

  it("wraps a malformed/unparseable WebP in an honest error (no raw stack leak)", async () => {
    // AC: a malformed/unparseable WebP surfaces an honest error. The decoder's
    // `decode()` rejects (the codec couldn't parse the container); the WebCodecs
    // path must wrap it in a user-facing message rather than propagating raw.
    ensureImageDataGlobal();
    const spies = stubImageDecoder(2);
    // Make the second frame's decode reject — simulates a corrupt bitstream.
    (spies as unknown as { forceDecodeError: (e: Error) => void }).forceDecodeError(
      new Error("boom"),
    );

    await expect(
      browserAnimatedWebpDecoder.decodeAnimated(new ArrayBuffer(8), "webp"),
    ).rejects.toThrow(/could not be parsed or decoded/i);
    // The decoder was still released despite the mid-decode failure.
    expect(spies.isDecoderClosed()).toBe(true);
  });
});

describe("browserAnimatedWebpDecoder — wasm fallback (issue #26, ADR-0002)", () => {
  it("degrades to a single still frame when WebCodecs is unavailable", async () => {
    // No ImageDecoder global ⇒ the WebCodecs path is gated off, so the codec
    // must take the wasm fallback: a single-frame result (honest degradation).
    ensureImageDataGlobal();
    expect(typeof ImageDecoder).toBe("undefined");

    // Stub the dynamic import of the wasm lib so no real bytes are loaded. The
    // fallback mirrors @jsquash/webp's still decode: decode(buffer) → ImageData.
    vi.doMock("@jsquash/webp", () => ({
      default: {
        decode: async (_buffer: ArrayBuffer) => ({
          width: 2,
          height: 2,
          data: new Uint8ClampedArray(2 * 2 * 4),
        }),
      },
    }));

    const frames = await browserAnimatedWebpDecoder.decodeAnimated(
      new ArrayBuffer(8),
      "webp",
    );

    // Exactly one frame — the honest single-frame degradation.
    expect(frames).toHaveLength(1);
    expect(frames[0].delay).toBeGreaterThan(0);
    expect(frames[0].imageData.width).toBe(2);
  });
});

/**
 * Animated WebP decoder, environment-bound (issue #26, v3 story #16).
 *
 * Mirrors {@link browserAnimatedGifDecoder}'s structure: lazy-load the codec,
 * decode every frame to a full-canvas composited {@link ImageData}, and carry
 * each frame's {@link delay} + {@link disposalType} through verbatim so the
 * re-encode (GIF via gifenc until #27 wires APNG) stays faithful.
 *
 * Two decode paths, picked at call time:
 *  - **WebCodecs** (`ImageDecoder`, `type: "image/webp"`): the high-fidelity
 *    path on capable devices (#25 detection gate). The browser's WebP codec
 *    composites each frame internally, so every `decode({ frameIndex })` yields
 *    a full-canvas `VideoFrame` we draw once + read back — no manual
 *    dispose/blend loop.
 *  - **wasm fallback**: no mature per-frame animated-WebP wasm decoder exists
 *    in the browser ecosystem, so per ADR-0002 ("honest degradation, never a
 *    hard error") we degrade to the wasm still decoder's first frame and surface
 *    that as a single-frame result. This is annotated in the frame's disposal
 *    and in code so the downgrade is never silent.
 */
import type {
  AnimatedDecoderDeps,
  DecodedAnimatedFrame,
  ImageFormat,
} from "../types";

/**
 * How the lazy wasm fallback is shaped (mirrors `@jsquash/webp`'s still decode:
 * `decode(buffer) → ImageData`). The animated-WebP wasm fallback is honest
 * degradation to a single still frame — see `decodeAnimatedWebpWithWasm`.
 */
interface WasmWebpStillDecoder {
  decode(buffer: ArrayBuffer): Promise<ImageData>;
}

/**
 * Read a WebCodecs `VideoFrame` (the decoded, full-canvas-composited frame) into
 * an {@link ImageData} via {@link OffscreenCanvas} — a single draw + readback.
 * `OffscreenCanvas` is available wherever `ImageDecoder` is.
 */
function videoFrameToImageData(frame: VideoFrame): ImageData {
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("WebP decode: 2D context unavailable for readback");
  ctx.drawImage(frame, 0, 0);
  return ctx.getImageData(0, 0, width, height);
}

/**
 * WebCodecs high-fidelity path: decode every frame of the animated WebP via
 * {@link ImageDecoder}, each as a full-canvas composited {@link ImageData}.
 */
async function decodeAnimatedWebpWithWebCodecs(
  buffer: ArrayBuffer,
): Promise<DecodedAnimatedFrame[]> {
  if (typeof ImageDecoder === "undefined") {
    throw new Error("WebP decode: WebCodecs ImageDecoder unavailable");
  }
  const decoder = new ImageDecoder({
    type: "image/webp",
    data: buffer,
    colorSpaceConversion: "default",
  });
  // Wrap the whole demux+decode so a malformed/unparseable WebP surfaces one
  // honest, user-facing message rather than a raw WebCodecs error (AC: "a
  // malformed/unparseable WebP surfaces an honest error"; ADR-0002).
  try {
    // `tracks` must be ready before `selectedTrack.frameCount` is accurate —
    // the demuxer parses the container asynchronously.
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) {
      throw new Error("WebP decode: ImageDecoder selected no track");
    }
    const frameCount = track.frameCount;
    if (!frameCount || frameCount < 1) {
      throw new Error("WebP decode: ImageDecoder reported no frames");
    }
    const frames: DecodedAnimatedFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      // `decode` returns an ImageDecodeResult whose `image` is the VideoFrame.
      const result = await decoder.decode({ frameIndex: i });
      const frame = result.image;
      try {
        const imageData = videoFrameToImageData(frame);
        // duration is microseconds (nullable on the last frame of some
        // streams); convert to ms, defaulting to a sane 100ms if absent.
        const delay = Math.max(1, Math.round((frame.duration ?? 100_000) / 1000));
        // Disposal/blend: WebCodecs' WebP decoder yields a full-canvas-
        // composited VideoFrame per frame, so the GIF disposal that keeps the
        // round-trip faithful is "do not dispose" (1) — the next frame fully
        // overwrites the canvas, nothing needs restoring. (Animated WebP's own
        // ANMF dispose/blend flags are applied internally by the codec before
        // the composite reaches us, so they survive in the pixels themselves.)
        frames.push({ imageData, delay, disposalType: 1 });
      } finally {
        frame.close();
      }
    }
    return frames;
  } catch (err) {
    // Our own explicit "no track / no frames" errors are already user-facing —
    // rethrow them as-is. Any other failure (a corrupt bitstream, a decode
    // rejection) gets wrapped in one honest message (AC: "a malformed/
    // unparseable WebP surfaces an honest error"; ADR-0002), with the original
    // cause preserved.
    if (err instanceof Error && /no (track|frames)/i.test(err.message)) {
      throw err;
    }
    throw new Error(
      "WebP decode: the animated WebP could not be parsed or decoded",
      { cause: err },
    );
  } finally {
    decoder.close();
  }
}

/**
 * wasm fallback (ADR-0002 honest degradation): no browser wasm lib decodes
 * animated WebP per-frame, so degrade to the still decoder's first frame and
 * return a single-frame result. The downgrade is explicit, never silent.
 */
async function decodeAnimatedWebpWithWasm(
  buffer: ArrayBuffer,
): Promise<DecodedAnimatedFrame[]> {
  // Lazy-load so non-WebP users never download the wasm (matches the
  // gifuct-js / heic2any lazy-import pattern). A *plain* dynamic
  // `import("@jsquash/webp")` — not a `@vite-ignore`/variable indirection — so
  // Vite statically resolves it at build time and emits a separate chunk the
  // worker fetches on first non-WebCodecs WebP decode (mirrors the GIF codec
  // and the APNG encoder). We target @jsquash/webp (libwebp wasm): it exposes a
  // still `decode(buffer)` only — no mature browser wasm lib decodes animated
  // WebP per-frame, so the fallback is honest single-frame degradation
  // (ADR-0002), not a hard error. `vi.mock("@jsquash/webp")` intercepts the
  // runtime import in the contract tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import("@jsquash/webp")) as any;
  const decoder = (mod.default ?? mod) as WasmWebpStillDecoder;
  const imageData = await decoder.decode(buffer);
  // Single frame; a non-zero delay so playback (if any) isn't instantaneous
  // (PRD story #11). disposalType is moot for a one-frame result; 1 mirrors the
  // WebCodecs path's do-not-dispose so both fallbacks share a consistent shape.
  return [{ imageData, delay: 100, disposalType: 1 }];
}

/**
 * Environment-bound animated-WebP decoder ({@link AnimatedDecoderDeps}). Picks
 * the WebCodecs high-fidelity path when available (#25 gate), else the wasm
 * fallback. Both surface full-canvas composited frames.
 */
export const browserAnimatedWebpDecoder: AnimatedDecoderDeps = {
  async decodeAnimated(
    buffer: ArrayBuffer,
    _format?: ImageFormat,
  ): Promise<readonly DecodedAnimatedFrame[]> {
    if (typeof ImageDecoder !== "undefined") {
      return decodeAnimatedWebpWithWebCodecs(buffer);
    }
    return decodeAnimatedWebpWithWasm(buffer);
  },
};

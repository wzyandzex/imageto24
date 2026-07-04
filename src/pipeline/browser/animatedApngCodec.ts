/**
 * Environment-bound animated-APNG codec (issues #27 / #37) — the browser-side
 * implementation of {@link AnimatedDecoderDeps} and {@link AnimatedEncoderDeps}
 * for the high-fidelity APNG path.
 *
 * The encoder is the v3 colour-fidelity win: where GIF output quantizes every
 * frame to ≤256 colours, APNG carries full true-colour RGBA. The decoder is the
 * v4 APNG-input slice: WebCodecs `ImageDecoder` is the native path; without it a
 * self-built APNG parser reconstructs per-frame PNGs and decodes them with pngjs.
 */
import { decodeApngFrames } from "./apngParser";
import type {
  AnimatedDecoderDeps,
  AnimatedEncoderDeps,
  DecodedAnimatedFrame,
  ImageData,
  ImageFormat,
} from "../types";

/* -------------------------------------------------------------------------- */
/* Decoder (WebCodecs → ImageData, fallback parser + pngjs)                    */
/* -------------------------------------------------------------------------- */

function videoFrameToImageData(frame: VideoFrame): ImageData {
  const width = frame.codedWidth;
  const height = frame.codedHeight;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("APNG decode: 2D context unavailable for readback");
  ctx.drawImage(frame, 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height);
  return {
    width,
    height,
    data: new Uint8ClampedArray(pixels.data),
  };
}

async function decodeAnimatedApngWithWebCodecs(
  buffer: ArrayBuffer,
): Promise<DecodedAnimatedFrame[]> {
  if (typeof ImageDecoder === "undefined") {
    throw new Error("APNG decode: WebCodecs ImageDecoder unavailable");
  }
  const decoder = new ImageDecoder({
    type: "image/png",
    data: buffer,
    colorSpaceConversion: "default",
  });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    if (!track) throw new Error("APNG decode: ImageDecoder selected no track");
    const frameCount = track.frameCount;
    if (!frameCount || frameCount < 1) {
      throw new Error("APNG decode: ImageDecoder reported no frames");
    }

    const frames: DecodedAnimatedFrame[] = [];
    for (let i = 0; i < frameCount; i++) {
      const result = await decoder.decode({ frameIndex: i });
      const frame = result.image;
      try {
        frames.push({
          imageData: videoFrameToImageData(frame),
          delay: Math.max(1, Math.round((frame.duration ?? 100_000) / 1000)),
          // WebCodecs returns composited full-canvas VideoFrames; disposal/blend
          // have already affected the pixels, so do-not-dispose is sufficient.
          disposalType: 1,
        });
      } finally {
        frame.close();
      }
    }
    return frames;
  } catch (err) {
    if (err instanceof Error && /no (track|frames)/i.test(err.message)) {
      throw err;
    }
    throw new Error(
      "APNG decode: the animated PNG could not be parsed or decoded",
      { cause: err },
    );
  } finally {
    decoder.close();
  }
}

async function decodeAnimatedApngWithPngjs(
  buffer: ArrayBuffer,
): Promise<DecodedAnimatedFrame[]> {
  try {
    const [{ Buffer }, mod] = await Promise.all([
      import("buffer"),
      import("pngjs/browser") as Promise<typeof import("pngjs/browser")>,
    ]);
    return decodeApngFrames(buffer, async (pngBuffer) => {
      const bytes = new Uint8Array(pngBuffer);
      const png = mod.PNG.sync.read(Buffer.from(bytes));
      return {
        width: png.width,
        height: png.height,
        data: new Uint8ClampedArray(png.data),
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("APNG decode:")) throw err;
    throw new Error(
      "APNG decode: the animated PNG could not be parsed or decoded",
      { cause: err },
    );
  }
}

export const browserAnimatedApngDecoder: AnimatedDecoderDeps = {
  async decodeAnimated(
    buffer: ArrayBuffer,
    _format?: ImageFormat,
  ): Promise<readonly DecodedAnimatedFrame[]> {
    if (typeof ImageDecoder !== "undefined") {
      return decodeAnimatedApngWithWebCodecs(buffer);
    }
    return decodeAnimatedApngWithPngjs(buffer);
  },
};

/* -------------------------------------------------------------------------- */
/* Encoder (UPNG.js → APNG)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Re-encode a sequence of enhanced frames as a playable animated APNG.
 *
 * UPNG.js's `encode(imgs, w, h, cnum, delays)` takes one RGBA `ArrayBuffer` per
 * frame plus a parallel `delays` array (milliseconds). The colour count `cnum`
 * is the crux of colour fidelity:
 *
 *  - `cnum: 0` ⇒ **lossless true-colour** — no palette is built, every frame's
 *    full RGBA is written (PNG colour type 6, 8-bit/channel). This is the APNG
 *    path's whole reason for existing (PRD: "Colour fidelity is the point of
 *    v3"); the faithful upscale's output is preserved exactly, no 256-colour
 *    quantization as on the GIF path.
 *  - `cnum > 0` would quantize to that many colours — deliberately not used,
 *    since it would reintroduce exactly the banding APNG exists to avoid.
 *
 * Transparency is inherent to RGBA (PNG colour type 6), so the alpha channel
 * the frames already carry flows straight through — no transparent-index slot
 * to reserve as GIF requires. Frame timing is passed as the `delays` array
 * (PRD story #11). The result is a standalone `ArrayBuffer` so it transfers
 * cleanly across the worker boundary.
 *
 * GIF disposal methods (`disposalType`) are irrelevant to APNG output: the
 * decoded frames the orchestrator hands us are already full-canvas-composited
 * (the decoder applied disposal/offset/transparency), so APNG's default "blend
 * over / do not dispose" composites them identically on playback. We therefore
 * do not pass disposal through — unlike the GIF encoder, which re-emits the
 * original disposal method because GIF's universal playback depends on it.
 */
export const browserAnimatedApngEncoder: AnimatedEncoderDeps = {
  async encodeAnimated(
    frames: ReadonlyArray<{
      imageData: ImageData;
      delay: number;
      disposalType: number;
    }>,
    options: { width: number; height: number },
  ): Promise<ArrayBuffer> {
    // Lazy-load so the codec never reaches a non-APNG user's bundle. A *plain*
    // dynamic `import("upng-js")` — not a `@vite-ignore`/variable indirection —
    // so Vite statically resolves it at build time and emits it as a separate
    // chunk the worker fetches on first APNG output. This mirrors the GIF codec
    // (`import("gifenc")`, `import("gifuct-js")`) and the WebP codec
    // (`import("@jsquash/webp")`). The earlier `@vite-ignore` form leaked the
    // bare specifier into the production worker bundle, where the browser could
    // not resolve it (`Failed to resolve module specifier 'upng-js'`) — the
    // tracer-bullet e2e (#28) caught this. `vi.mock("upng-js")` still
    // intercepts the runtime import in the contract tests.
    const mod = (await import("upng-js")) as {
      default: { encode: typeof import("upng-js").encode };
    };
    const UPNG = mod.default;
    const { width, height } = options;

    // UPNG wants one RGBA ArrayBuffer per frame. The frames' `data` is a
    // `Uint8ClampedArray` (the pipeline's ImageData shape); copy each into a
    // fresh `ArrayBuffer` so UPNG owns its own bytes (and the encoder never
    // mutates the upscaled frame the caller still holds). A clamped array's
    // `.buffer` is a regular ArrayBuffer of exactly the pixel length — but a
    // view into it could have an offset/length, so we copy from the view to be
    // safe rather than assume the backing buffer is tight.
    const imgs: ArrayBuffer[] = frames.map((frame) => {
      const rgba = frame.imageData.data;
      const buf = new ArrayBuffer(rgba.length);
      new Uint8Array(buf).set(rgba);
      return buf;
    });

    // `delays`: per-frame delay in milliseconds, in frame order. UPNG emits a
    // still PNG when this is omitted, so it must be supplied for an animation.
    const delays = frames.map((frame) => frame.delay);

    // cnum: 0 ⇒ lossless true-colour. This is the single most important argument
    // here — it is what makes APNG output a colour-fidelity win over GIF (PRD
    // "Colour fidelity"). Do not quantize.
    return UPNG.encode(imgs, width, height, 0, delays);
  },
};

/**
 * Environment-bound animated-APNG encoder (issue #27) — the browser-side
 * implementation of {@link AnimatedEncoderDeps} for the v3 high-fidelity path.
 *
 * This is the symmetric counterpart to {@link browserAnimatedGifEncoder} and the
 * colour-fidelity win of v3: where the GIF encoder must quantize every frame to
 * ≤256 colours (an inherent GIF limit, ADR-0006), APNG carries full true-colour
 * RGBA — nothing the faithful/Lanczos upscale preserved gets posterized on
 * output. Per ADR-0007 this encoder is selected on WebCodecs-capable devices
 * (the same gate that picks the lossless WebP *decode*), tying one clean
 * capability boundary to a fully lossless round-trip.
 *
 * UPNG.js (~30KB) is lazy-`import()`ed inside the function, so a user who never
 * produces an APNG output (stills, or animated output on a non-WebCodecs device)
 * never downloads it — the same lazy-load strategy the GIF line uses for gifenc.
 *
 * This module is **not** unit-tested at the pixel level: it is bound to the
 * UPNG.js codec, just as `animatedGifCodec.ts` is bound to gifenc. Its contract
 * (true-colour, no quantization; transparency; per-frame timing) is asserted via
 * a stubbed UPNG in `animatedApngCodec.test.ts`, and the full round-trip is
 * exercised end-to-end by the Playwright suite (which re-decodes the APNG).
 */
import type { AnimatedEncoderDeps, ImageData } from "../types";

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

/**
 * Minimal ambient declaration for `upng-js` (issue #27) — the package ships no
 * TypeScript types. Only the encode surface the animated-APNG encoder uses is
 * declared; the full API is wider (see https://github.com/photopea/UPNG.js).
 *
 * UPNG.js is lazy-`import()`ed inside the worker-bound codec
 * (src/pipeline/browser/animatedApngCodec.ts), so a user who never produces an
 * APNG output never downloads it (~30KB; matches the gifenc / heic2any pattern).
 *
 * Like `jsquash-webp.d.ts`, this declaration lets the lazy-`import()` type-check
 * even before the dep is physically installed — npm's registry cache was
 * permission-blocked in this environment, so `upng-js` is added to
 * `package.json` and installed out-of-band. Once present the declaration is a
 * fallback only (a package-supplied type would take precedence).
 */
declare module "upng-js" {
  /**
   * Encode one or more RGBA frames into a PNG or APNG.
   *
   * @param imgs   the frame pixels: an array of `ArrayBuffer`s, each a width×height×4
   *               RGBA buffer (one per frame; a single buffer ⇒ a still PNG).
   * @param width  canvas width (all frames share it).
   * @param height canvas height (all frames share it).
   * @param cnum   colour count for palette quantization. `0` ⇒ lossless
   *               true-colour (no quantization) — the colour-fidelity choice for
   *               APNG output (PRD "Colour fidelity is the point of v3"). `>0`
   *               quantizes to that many colours.
   * @param delays optional per-frame delays in milliseconds (one per frame); when
   *               omitted UPNG emits a still image.
   * @returns the encoded PNG/APNG bytes as a fresh `ArrayBuffer`.
   */
  export function encode(
    imgs: ArrayBuffer[],
    width: number,
    height: number,
    cnum: number,
    delays?: number[],
  ): ArrayBuffer;

  const UPNG: { encode: typeof encode };
  export default UPNG;
}

/**
 * Minimal ambient declaration for the animated-WebP wasm fallback decoder
 * (issue #26): `@jsquash/webp`, a libwebp wasm build wrapped for the browser.
 *
 * Honest degradation (ADR-0002): no mature browser wasm lib decodes animated
 * WebP *per frame*, so the fallback uses `@jsquash/webp`'s still decode
 * (first frame only) and surfaces it as a single-frame result. See
 * `src/pipeline/browser/animatedWebpCodec.ts` (`decodeAnimatedWebpWithWasm`).
 *
 * The package ships its own `.d.ts`, so once installed this ambient declaration
 * is a fallback only — kept so the lazy-`import()` type-checks even before the
 * dep is present (npm registry was sandbox-blocked during #26's implementation;
 * the package is added to `package.json` and installed out-of-band).
 *
 * Lazy-`import()`ed inside the worker-bound codec, so non-WebP users never
 * download the wasm (matches the gifenc / heic2any pattern).
 */
declare module "@jsquash/webp" {
  /**
   * Decode a WebP still to an {@link ImageData}. The reference libwebp wasm
   * decode surface; the animated fallback reads only the first frame.
   */
  export function decode(buffer: ArrayBuffer | Uint8Array): Promise<ImageData>;
  const _default: { decode: typeof decode };
  export default _default;
}

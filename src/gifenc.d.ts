/**
 * Minimal ambient declaration for `gifenc` (issue #18) — the package ships no
 * TypeScript types. Only the surface the animated-GIF encoder uses is declared;
 * the full API is wider (see https://github.com/mattdesl/gifenc).
 *
 * gifenc is lazy-`import()`ed inside the worker-bound codec
 * (src/pipeline/browser/animatedGifCodec.ts), so non-animated users never
 * download it (matches the heic2any pattern).
 */
declare module "gifenc" {
  /**
   * Palette entry — gifenc uses `[r, g, b, a]` tuples when quantizing in the
   * `rgba4444` format (which keeps alpha, so transparency survives the
   * 256-colour GIF limit).
   */
  export type PaletteColor = [number, number, number, number];

  /** Per-frame write options for {@link GIFEncoder.writeFrame}. */
  export interface GifFrameOptions {
    /** The 256-colour (max) palette for *this* frame, from `quantize`. */
    palette?: number[][];
    /** Frame delay in milliseconds (gifenc divides by 10 into centi-seconds). */
    delay?: number;
    /** Loop count: `0` loops forever (PRD story #11). */
    repeat?: number;
    /** Enable a transparent palette entry so alpha survives the re-encode. */
    transparent?: boolean;
    /** Palette index treated as transparent when `transparent` is true. */
    transparentIndex?: number;
    /** Disposal method (0-3); carried through if the decoder reported one. */
    dispose?: number;
    /** Whether this is the first frame (gifenc optimizes the header). */
    first?: boolean;
  }

  /** gifenc's incremental animated-GIF writer. */
  export interface GIFEncoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: GifFrameOptions,
    ): void;
    /** Writes the end-of-stream marker — required after the last frame. */
    finish(): void;
    /** A fresh copy of the encoded bytes. */
    bytes(): Uint8Array;
    /** A direct view of the underlying buffer (no copy; use carefully). */
    bytesView(): Uint8Array;
    /** Reset the writer for reuse. */
    reset(): void;
  }

  /** Quantization format. `rgba4444` keeps alpha so transparency survives. */
  export type QuantizeFormat = "rgb565" | "rgba4444" | "rgb444";

  export interface QuantizeOptions {
    format?: QuantizeFormat;
    /**
     * Treat alpha as binary (transparent or opaque). `true` pairs with
     * `rgba4444` so the palette reserves a slot for full transparency.
     */
    oneBitAlpha?: boolean | number;
    /** Replace near-transparent pixels' RGB with {@link clearAlphaColor}. */
    clearAlpha?: boolean;
    clearAlphaThreshold?: number;
    clearAlphaColor?: number;
  }

  /** Construct an incremental GIF writer. */
  export function GIFEncoder(opts?: {
    auto?: boolean;
    initialCapacity?: number;
  }): GIFEncoder;

  /** Reduce an RGBA image to a ≤256-colour palette (gifenc's Wu quantizer). */
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: QuantizeOptions,
  ): number[][];

  /** Map an RGBA image onto a palette, producing per-pixel indices. */
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format: QuantizeFormat,
  ): Uint8Array;
}

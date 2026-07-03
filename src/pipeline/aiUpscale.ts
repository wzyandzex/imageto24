/**
 * Pure AI-mode upscale dispatch — the testable core of Real-ESRGAN enhancement.
 *
 * The actual ONNX inference is environment-bound and arrives as an injected
 * {@link AiInferenceSession} (created by the browser model loader, ADR-0003).
 * This module owns the *structure* around that call: convert pixels to the
 * model's tensor layout, run inference at the model's native factor, convert
 * back, then Lanczos-resize the native output onto the exact requested target.
 *
 * ## Tiling (issue #44)
 * Real-ESRGAN inference on a whole large image builds activation tensors many
 * times the image size, which overflows GPU/WASM memory — previously the memory
 * gate simply refused AI and fell back to faithful, so "AI 4K" silently became
 * plain Lanczos on large sources. Instead we split the source into fixed tiles
 * with an overlap margin, run the session per tile, and stitch the results:
 *
 *   - Each tile is padded by {@link AiUpscaleOptions.tile.padding} source pixels
 *     on every side (clamped to the image) before inference. Real-ESRGAN's
 *     receptive field means edge pixels are reconstructed with less context; the
 *     padding gives interior pixels full context and the padded margin is cropped
 *     off after inference, hiding tile seams.
 *   - Only the tile's *core* region (its native-scaled output, with the padding
 *     margin removed) is blitted into the full native canvas, so tiles abut with
 *     no double-counting and no visible seam.
 *   - Peak inference memory is bounded by the (padded) tile size, not the whole
 *     image, so arbitrarily large sources run AI within a fixed budget.
 *
 * Small images (within one tile) skip tiling entirely and take the original
 * single-inference path — behaviour there is unchanged.
 *
 * Keeping this logic pure (no ORT import, no browser globals) is what lets the
 * AI path be tested under Vitest in Node with a stub session — asserting the
 * pipeline is invoked correctly and the output dimensions/shape are valid, and
 * that tiled stitching matches a whole-image reference for a deterministic stub,
 * without asserting pixel quality (which is non-deterministic and GPU-bound —
 * PRD testing decisions, issue #6).
 *
 * Real-ESRGAN tensor contract (general model):
 *   input  : float32 NCHW [1, 3, H,  W ], RGB in [0, 1]
 *   output : float32 NCHW [1, 3, H*s, W*s], RGB in [0, 1], where s = nativeFactor
 * Alpha is not modelled by Real-ESRGAN; the output is fully opaque.
 */
import { lanczosResize } from "./lanczos";
import type {
  AiInferenceSession,
  ImageData,
  UpscaleFactor,
} from "./types";

/** The model's input/output tensor names. Real-ESRGAN exports use these. */
export const REAL_ESRGAN_INPUT = "input";
export const REAL_ESRGAN_OUTPUT = "output";

/** Default tile size (source pixels, square). 256 balances seams vs. overhead. */
export const DEFAULT_TILE_SIZE = 256;
/** Default overlap margin (source pixels) padded around each tile before inference. */
export const DEFAULT_TILE_PADDING = 16;

/** A tensor as carried across the {@link AiInferenceSession} boundary. */
export interface NchwTensor {
  /** Row-major NCHW float data, length === 1 * 3 * height * width. */
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Convert RGBA {@link ImageData} (0–255) into a planar NCHW float tensor (0–1),
 * dropping alpha. Pure and allocation-bounded; deterministic for a given input.
 */
export function imageDataToNchw(image: ImageData): NchwTensor {
  const { width, height, data } = image;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) {
    const src = p * 4;
    out[p] = data[src] / 255; // R plane
    out[plane + p] = data[src + 1] / 255; // G plane
    out[2 * plane + p] = data[src + 2] / 255; // B plane
  }
  return { data: out, width, height };
}

/**
 * Convert a planar NCHW float tensor (0–1, RGB) back into RGBA {@link ImageData}
 * (0–255), clamping out-of-range values and setting alpha fully opaque. Pure.
 */
export function nchwToImageData(tensor: NchwTensor): ImageData {
  const { width, height, data } = tensor;
  const plane = width * height;
  const out = new Uint8ClampedArray(plane * 4);
  for (let p = 0; p < plane; p++) {
    const dst = p * 4;
    // Uint8ClampedArray clamps to [0, 255]; *255 with no manual clamp is safe.
    out[dst] = data[p] * 255;
    out[dst + 1] = data[plane + p] * 255;
    out[dst + 2] = data[2 * plane + p] * 255;
    out[dst + 3] = 255;
  }
  return { width, height, data: out };
}

/** A rectangle in pixel space. */
export interface TileRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One tile: the `core` region it owns, and the `padded` region fed to inference. */
export interface TilePlan {
  /** The region this tile is responsible for (abuts its neighbours, no overlap). */
  readonly core: TileRect;
  /** The core expanded by the overlap margin, clamped to the image bounds. */
  readonly padded: TileRect;
}

/**
 * Partition a (width × height) image into a grid of tiles, each padded by
 * `padding` source pixels (clamped to the image). Pure — depends only on its
 * numeric arguments, so the plan is deterministic and unit-testable.
 */
export function planTiles(
  width: number,
  height: number,
  tileSize: number,
  padding: number,
): TilePlan[] {
  const plans: TilePlan[] = [];
  for (let y = 0; y < height; y += tileSize) {
    const coreH = Math.min(tileSize, height - y);
    const py = Math.max(0, y - padding);
    const pBottom = Math.min(height, y + coreH + padding);
    for (let x = 0; x < width; x += tileSize) {
      const coreW = Math.min(tileSize, width - x);
      const px = Math.max(0, x - padding);
      const pRight = Math.min(width, x + coreW + padding);
      plans.push({
        core: { x, y, width: coreW, height: coreH },
        padded: { x: px, y: py, width: pRight - px, height: pBottom - py },
      });
    }
  }
  return plans;
}

/** Copy a rectangular sub-region out of an image into a new tightly-packed ImageData. */
function extractRegion(image: ImageData, rect: TileRect): ImageData {
  const { x, y, width: w, height: h } = rect;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((y + row) * image.width + x) * 4;
    out.set(image.data.subarray(srcStart, srcStart + w * 4), row * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Blit a `w × h` sub-rect of `src` (at sx,sy) into `dest` at (dx,dy). Mutates dest. */
function blitRegion(
  dest: ImageData,
  dx: number,
  dy: number,
  src: ImageData,
  sx: number,
  sy: number,
  w: number,
  h: number,
): void {
  for (let row = 0; row < h; row++) {
    const srcStart = ((sy + row) * src.width + sx) * 4;
    const dstStart = ((dy + row) * dest.width + dx) * 4;
    dest.data.set(src.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
}

/** Run one (padded) tile through the session and return its native-scaled pixels. */
async function inferTile(
  session: AiInferenceSession,
  tileImage: ImageData,
): Promise<ImageData> {
  const input = imageDataToNchw(tileImage);
  const outputs = await session.run({ [REAL_ESRGAN_INPUT]: input });
  const native = outputs[REAL_ESRGAN_OUTPUT] as NchwTensor | undefined;
  if (!native || !(native.data instanceof Float32Array)) {
    throw new Error("AI inference returned no usable output tensor");
  }
  return nchwToImageData(native);
}

/** The subset of upscale options the AI dispatch needs. */
export interface AiUpscaleOptions {
  readonly factor: UpscaleFactor;
  /** Native integer factor the model scales by (Real-ESRGAN: 4). */
  readonly nativeFactor: UpscaleFactor;
  /** Exact target size, when the orchestrator requested a tier-precise landing. */
  readonly exactTargetSize?: { readonly width: number; readonly height: number };
  /**
   * Tiling configuration (issue #44). Omitted ⇒ {@link DEFAULT_TILE_SIZE} /
   * {@link DEFAULT_TILE_PADDING}. Images that fit within one tile skip tiling.
   */
  readonly tile?: { readonly size?: number; readonly padding?: number };
  /**
   * Optional per-tile progress, fired after each tile's inference in row-major
   * order (`done` counts completed tiles, `total` is the tile count). Fires once
   * with total=1 on the single-inference (small-image) path. Never throws from
   * here — the caller's callback owns its own errors.
   */
  readonly onTileProgress?: (done: number, total: number) => void;
}

/**
 * Resize a native-scale image onto the requested target (exact size when given,
 * else source × factor). Skips the resize when the native output already matches.
 */
function resizeToTarget(
  native: ImageData,
  sourceWidth: number,
  sourceHeight: number,
  options: AiUpscaleOptions,
): ImageData {
  const target = options.exactTargetSize ?? {
    width: sourceWidth * options.factor,
    height: sourceHeight * options.factor,
  };
  if (native.width === target.width && native.height === target.height) {
    return native;
  }
  return lanczosResize(native, target.width, target.height);
}

/**
 * Run AI enhancement on an image through an injected inference session, then land
 * the result exactly on the requested target.
 *
 * 1. Tile the source (unless it fits in one tile) and run the session per padded
 *    tile, stitching each tile's cropped core into the full native canvas.
 * 2. Resize (Lanczos) the stitched native output onto the requested target — the
 *    model output is `nativeFactor`×, but the user may have asked for 2×/3× or an
 *    exact tier long edge, so we down/up-sample to land precisely. When the
 *    native output already matches the target, the resize is skipped.
 *
 * This pure function does NOT release the session. Session lifecycle belongs to
 * the loader that owns it (see the module JSDoc / #46 batch reuse) — having the
 * pure dispatch tear down a resource it didn't create would break the batch
 * session cache, so release stays out of this seam.
 */
export async function aiUpscale(
  session: AiInferenceSession,
  image: ImageData,
  options: AiUpscaleOptions,
): Promise<ImageData> {
  const tileSize = options.tile?.size ?? DEFAULT_TILE_SIZE;
  const padding = options.tile?.padding ?? DEFAULT_TILE_PADDING;
  const nativeFactor = options.nativeFactor;

  // Small image: one inference, no tiling — the original path (behaviour
  // unchanged). The native output dims come straight off the returned tensor.
  if (image.width <= tileSize && image.height <= tileSize) {
    const native = await inferTile(session, image);
    options.onTileProgress?.(1, 1);
    return resizeToTarget(native, image.width, image.height, options);
  }

  // Tiled path: stitch each tile's native-scaled core into the full canvas.
  const fullWidth = image.width * nativeFactor;
  const fullHeight = image.height * nativeFactor;
  const full: ImageData = {
    width: fullWidth,
    height: fullHeight,
    data: new Uint8ClampedArray(fullWidth * fullHeight * 4),
  };

  const plans = planTiles(image.width, image.height, tileSize, padding);
  for (let i = 0; i < plans.length; i++) {
    const { core, padded } = plans[i];
    const tileOut = await inferTile(session, extractRegion(image, padded));

    const expectedW = padded.width * nativeFactor;
    const expectedH = padded.height * nativeFactor;
    if (tileOut.width !== expectedW || tileOut.height !== expectedH) {
      throw new Error(
        `AI tile output ${tileOut.width}×${tileOut.height} does not match the ` +
          `expected ${expectedW}×${expectedH} for nativeFactor ${nativeFactor}`,
      );
    }

    // Crop the padding margin off the tile output and place its core into `full`.
    const srcX = (core.x - padded.x) * nativeFactor;
    const srcY = (core.y - padded.y) * nativeFactor;
    blitRegion(
      full,
      core.x * nativeFactor,
      core.y * nativeFactor,
      tileOut,
      srcX,
      srcY,
      core.width * nativeFactor,
      core.height * nativeFactor,
    );

    options.onTileProgress?.(i + 1, plans.length);
  }

  return resizeToTarget(full, image.width, image.height, options);
}

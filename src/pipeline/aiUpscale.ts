/**
 * Pure AI-mode upscale dispatch — the testable core of Real-ESRGAN enhancement.
 *
 * The actual ONNX inference is environment-bound and arrives as an injected
 * {@link AiInferenceSession} (created by the browser model loader, ADR-0003).
 * This module owns the *structure* around that call: convert pixels to the
 * model's tensor layout, run inference at the model's native factor, convert
 * back, then Lanczos-resize the native output onto the exact requested target.
 *
 * Keeping this logic pure (no ORT import, no browser globals) is what lets the
 * AI path be tested under Vitest in Node with a stub session — asserting the
 * pipeline is invoked correctly and the output dimensions/shape are valid,
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

/** The subset of upscale options the AI dispatch needs. */
export interface AiUpscaleOptions {
  readonly factor: UpscaleFactor;
  /** Native integer factor the model scales by (Real-ESRGAN: 4). */
  readonly nativeFactor: UpscaleFactor;
  /** Exact target size, when the orchestrator requested a tier-precise landing. */
  readonly exactTargetSize?: { readonly width: number; readonly height: number };
}

/**
 * Run AI enhancement on an image through an injected inference session, then land
 * the result exactly on the requested target.
 *
 * 1. Pre-process pixels → NCHW tensor.
 * 2. Run the session at the model's native factor.
 * 3. Post-process the native output tensor → pixels.
 * 4. Resize (Lanczos) onto the requested target dimensions — the model output is
 *    `nativeFactor`×, but the user may have asked for 2×/3× or an exact tier
 *    long edge, so we down/up-sample to land precisely. When the native output
 *    already matches the target, the resize is skipped.
 *
 * This pure function does NOT release the session. Session lifecycle belongs to
 * the loader that owns it: in the current one-image-per-worker architecture the
 * session is GC'd when the worker terminates, and a future batch path would
 * cache the compiled session across images. Having the pure dispatch tear down a
 * resource it didn't create would block both, so release stays out of this seam.
 */
export async function aiUpscale(
  session: AiInferenceSession,
  image: ImageData,
  options: AiUpscaleOptions,
): Promise<ImageData> {
  const input = imageDataToNchw(image);
  const outputs = await session.run({ [REAL_ESRGAN_INPUT]: input });
  const native = outputs[REAL_ESRGAN_OUTPUT] as NchwTensor | undefined;
  if (!native || !(native.data instanceof Float32Array)) {
    throw new Error("AI inference returned no usable output tensor");
  }
  const enhanced = nchwToImageData(native);

  const target = options.exactTargetSize ?? {
    width: image.width * options.factor,
    height: image.height * options.factor,
  };
  if (enhanced.width === target.width && enhanced.height === target.height) {
    return enhanced;
  }
  return lanczosResize(enhanced, target.width, target.height);
}

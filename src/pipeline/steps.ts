/**
 * Minimal pipeline step implementations.
 *
 * Each function is pure with respect to globals: it operates only on its
 * arguments and delegates every environment-bound concern (Canvas/OffscreenCanvas
 * decode/encode, ONNX inference, model loading, capability detection) to an
 * injected dependency. This slice ships the seam structure; faithful Lanczos, AI
 * inference, classification, and capability-detection *logic* land in later
 * slices. Here they exist as injectable slots with trivial pass-throughs.
 */
import {
  type ContentType,
  type DecoderDeps,
  type DeviceCapability,
  type EncoderDeps,
  type EncodeOptions,
  type ImageData,
  type ImageFormat,
  type UpscaleOptions,
  type UpscalerDeps,
} from "./types";
import { classifyContent } from "./contentClassifier";

/**
 * Decode an encoded file into pixel data. The actual codec (browser-native or a
 * library) arrives via {@link DecoderDeps}; this function adds no behaviour.
 */
export async function decode(
  deps: DecoderDeps,
  buffer: ArrayBuffer,
  format: ImageFormat,
): Promise<ImageData> {
  return deps.decode(buffer, format);
}

/**
 * The upscale step. In faithful mode this is Lanczos interpolation; in AI mode it
 * is ONNX inference. Both arrive via {@link UpscalerDeps}; this is a thin
 * pass-through so the orchestrator stays decoupled from the dependency shape.
 */
export async function upscale(
  deps: UpscalerDeps,
  imageData: ImageData,
  options: UpscaleOptions,
): Promise<ImageData> {
  return deps.upscale(imageData, options);
}

/**
 * Encode pixel data back into a file, honouring the format/lossless/EXIF options.
 * The codec arrives via {@link EncoderDeps}.
 */
export async function encode(
  deps: EncoderDeps,
  imageData: ImageData,
  options: EncodeOptions,
): Promise<ArrayBuffer> {
  return deps.encode(imageData, options);
}

/**
 * Detect WebGPU support and the AI memory budget. The detection logic is
 * environment-bound and arrives via the injected function; this slice ships a
 * trivial stub default (see {@link defaultCapabilityDetector}) that later slices
 * replace with the real probe.
 */
export async function checkDeviceCapability(
  detect: () => Promise<DeviceCapability>,
): Promise<DeviceCapability> {
  return detect();
}

/**
 * Resolve the content type for AI model routing (issue #7, ADR-0003).
 *
 * A manual override (when the user picked "photo" or "anime" explicitly) always
 * wins — it is the safety net for misclassification. Otherwise the lightweight
 * colour-statistic classifier runs on the decoded pixels and returns in
 * milliseconds. The orchestrator always passes the decoded `imageData`; the
 * no-image branch exists only for direct unit use of this seam.
 *
 * @param override the user's manual choice, if any.
 * @param imageData decoded pixels to classify when there is no override.
 */
export function classify(
  override: ContentType | undefined,
  imageData?: ImageData,
): ContentType {
  if (override !== undefined) {
    return override;
  }
  if (imageData !== undefined) {
    return classifyContent(imageData);
  }
  return "photo";
}

/**
 * A trivial default capability detector, deliberately pessimistic. Real probes
 * (navigator.gpu, memory estimation) land in a later slice; in the meantime this
 * keeps the seam usable without fabricating WebGPU support.
 */
export const defaultCapabilityDetector = async (): Promise<DeviceCapability> => ({
  webgpu: false,
  memBudget: 0,
});

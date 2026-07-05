/**
 * Public surface of the image-upscaler pipeline.
 *
 * The pipeline is the project's testing stronghold seam (PRD testing decisions):
 * pure functions operating on {@link ImageData}, with every environment-bound
 * concern passed in as an injectable dependency. Import from here, not the
 * individual modules, unless you need an internal helper.
 */
export type {
  AnimatedImageFormat,
  AiModel,
  AiInferenceSession,
  ContentType,
  DecoderDeps,
  DecodedImage,
  DecodedAnimatedFrame,
  DeviceCapability,
  EncodeOptions,
  EncoderDeps,
  ImageData,
  ImageFormat,
  ModelLoaderDeps,
  ModelLoadProgress,
  ModelLoadProgressCb,
  FrameProgress,
  FrameProgressCb,
  OutputFormat,
  PipelineDeps,
  ProcessImageMeta,
  ProcessImageOptions,
  ProcessImageResult,
  ProcessingMode,
  ResolutionTier,
  TargetSpec,
  UpscaleFactor,
  UpscaleFactorResult,
  FaithfulUpscaleOptions,
  FaithfulUpscalerDeps,
  AiAdapterOptions,
  AiUpscalerDeps,
  AnimatedDecoderDeps,
  AnimatedEncoderDeps,
  AnimatedEncodeOptions,
} from "./types";

export type { CapabilityDecision } from "./capability";
export { estimateAiMemoryCost, resolveAiCapability } from "./capability";

export type { ExactTargetSize } from "./types";

export { TIER_LONG_EDGE } from "./types";

export {
  alignToSupportedFactor,
  computeUpscaleFactor,
  longEdge,
  tierToLongEdge,
  type SrcSize,
} from "./computeUpscaleFactor";

export { SUPPORTED_FACTORS } from "./computeUpscaleFactor";

export {
  type AxisTaps,
  clampIndex,
  dimsForLongEdge,
  lanczosKernel,
  lanczosResize,
  lanczosUpscale,
  LANCZOS_A,
  precomputeAxis,
} from "./lanczos";

export {
  applyExifOption,
  type JpegSegment,
  extractExifSegment,
  injectExifIntoJpeg,
  isExifApp1,
  parseJpegSegments,
} from "./exif";

export {
  type AiUpscaleOptions,
  type NchwTensor,
  aiUpscale,
  imageDataToNchw,
  nchwToImageData,
  REAL_ESRGAN_INPUT,
  REAL_ESRGAN_OUTPUT,
} from "./aiUpscale";

export { processImage } from "./processImage";

// Animated-image detection + orchestration (issue #16 detection/routing, issue
// #18 per-frame decode → upscale → re-encode). `detectAnimation` is the pure
// header scan the UI runs on upload to pick the run path; `processAnimated` is
// the animated counterpart to `processImage` — gifuct-js decode → per-frame
// upscale (faithful: every frame; AI: first frame per ADR-0006) → gifenc re-encode.
export {
  detectAnimation,
  type AnimationScan,
} from "./animatedDetect";
export { processAnimated } from "./processAnimated";

// Format matrix (issue #10): the pure policy above the browser codecs. The input
// codec (AVIF + GIF first-frame) is browser-native; these helpers decide decode
// strategy and resolve output format per the faithful lossless promise.
export {
  OUTPUT_FORMATS,
  decodeStrategy,
  isOutputFormat,
  outputExtension,
  outputMime,
  resolveOutput,
  type DecodeStrategy,
  type ResolvedOutput,
} from "./formats";

// Batch serial queue (issue #9): the multi-image pipeline. Serial by design —
// each image is fully processed and released from memory before the next begins
// (ADR-0001 browser-only memory constraint).
export {
  runBatch,
  type BatchItem,
  type BatchItemState,
  type BatchItemStatus,
  type BatchProgress,
} from "./runBatch";

/**
 * Public surface of the image-upscaler pipeline.
 *
 * The pipeline is the project's testing stronghold seam (PRD testing decisions):
 * pure functions operating on {@link ImageData}, with every environment-bound
 * concern passed in as an injectable dependency. Import from here, not the
 * individual modules, unless you need an internal helper.
 */
export type {
  AiModel,
  AiInferenceSession,
  ContentType,
  DecoderDeps,
  DecodedImage,
  DeviceCapability,
  EncodeOptions,
  EncoderDeps,
  ImageData,
  ImageFormat,
  ModelLoaderDeps,
  ModelLoadProgress,
  ModelLoadProgressCb,
  PipelineDeps,
  ProcessImageMeta,
  ProcessImageOptions,
  ProcessImageResult,
  ProcessingMode,
  ResolutionTier,
  TargetSpec,
  UpscaleFactor,
  UpscaleFactorResult,
  UpscaleOptions,
  UpscalerDeps,
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

export {
  checkDeviceCapability,
  classify,
  decode,
  defaultCapabilityDetector,
  encode,
  upscale,
} from "./steps";

export { processImage } from "./processImage";

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

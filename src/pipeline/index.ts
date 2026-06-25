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
  ContentType,
  DecoderDeps,
  DecodedImage,
  DeviceCapability,
  EncodeOptions,
  EncoderDeps,
  ImageData,
  ImageFormat,
  ModelLoaderDeps,
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
  checkDeviceCapability,
  classify,
  decode,
  defaultCapabilityDetector,
  encode,
  upscale,
} from "./steps";

export { processImage } from "./processImage";

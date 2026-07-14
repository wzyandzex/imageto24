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

export {
  MODEL_CATALOG,
  contentTypeForModel,
  getModelMetadata,
  isModelSelectable,
  modelLimitationSummary,
  resolveModelRouting,
  type AiModelMetadata,
  type ModelAlphaSupport,
  type ModelAvailabilityState,
  type ModelRoutingContext,
  type ModelRoutingDecision,
  type ModelRuntimeTarget,
  type ModelSourceType,
  type ModelStability,
} from "./modelRouting";

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

// Cloud temporal enhancement job seam (v5 issue #57). This is the contract and
// deterministic fake tracer used before any real GPU provider is wired in.
export {
  type CloudTemporalCreateJobPayload,
  type CloudTemporalJob,
  type CloudTemporalJobClient,
  type CloudTemporalJobFailure,
  type CloudTemporalJobRequestSnapshot,
  type CloudTemporalJobResult,
  type CloudTemporalJobResultSummary,
  type CloudTemporalJobStatus,
  type CloudTemporalModelRouting,
  type CloudTemporalOutputFormat,
  type CloudTemporalProcessingFailure,
  type CloudTemporalProcessingFailureReason,
  type CloudTemporalProductLimitFailure,
  type CloudTemporalProductLimitReason,
  type CloudTemporalProductLimits,
  type CloudTemporalRecoveryIdentity,
  type CloudTemporalSourceFile,
  type CloudTemporalSourceFormat,
  type CloudTemporalSourceMetadata,
  type FakeCloudTemporalJobClientOptions,
  CLOUD_TEMPORAL_ACCEPTED_SOURCE_FORMATS,
  CLOUD_TEMPORAL_JOB_STATUSES,
  DEFAULT_CLOUD_TEMPORAL_LIMITS,
  FakeCloudTemporalJobClient,
  cloudTemporalOutputMime,
  cloudTemporalTimeoutFailure,
  createFakeCloudTemporalJobClient,
  isTerminalCloudTemporalStatus,
  resolveCloudTemporalCreateLimitFailure,
  type CloudTemporalCreateLimitContext,
} from "./cloudTemporalJob";

// GPU service MVP core (v5 issue #64): environment-agnostic implementation of
// the independent service contract. HTTP/queue/storage/GPU providers are injected
// around this all-or-nothing temporal pipeline.
export {
  CloudTemporalGpuService,
  cloneCloudTemporalFrame,
  createCloudTemporalGpuService,
  type CloudTemporalEncodeOptions,
  type CloudTemporalEnhanceOptions,
  type CloudTemporalEnhancer,
  type CloudTemporalFrame,
  type CloudTemporalGpuServiceDeps,
  type CloudTemporalGpuServiceOptions,
  type CloudTemporalSequenceDecoder,
  type CloudTemporalSequenceEncoder,
} from "./cloudTemporalService";

// HTTP adapter for the independent GPU service host (iteration C). Node-only
// codec wiring lives under scripts/ so the browser bundle never pulls it in.
export {
  handleCloudTemporalHttpRequest,
  DEFAULT_CLOUD_TEMPORAL_MAX_BODY_BYTES,
  type CloudTemporalHttpOptions,
} from "./cloudTemporalHttp";

// Shared animated-GIF compositor + encoder (browser codec + Node cloud host).
export { decodeGifSequence } from "./decodeGifSequence";
export { encodeGifSequence, type EncodeGifSequenceOptions, type GifEncodeFrame } from "./encodeGifSequence";

// Free local temporal-consistency pass (Lanczos + neighbour blend; not neural).
export {
  enhanceWithTemporalConsistency,
  blendWithNeighbours,
  temporalNeighbourWeight,
  TEMPORAL_CONSISTENCY_MAX_NEIGHBOUR_WEIGHT,
  type TemporalConsistencyFrame,
  type TemporalConsistencyOptions,
} from "./temporalConsistency";


// Create-job rate limiting for the HTTP host (optional inject).
export {
  cloudTemporalClientKey,
  createCloudTemporalRateLimiter,
  type CloudTemporalRateLimitDecision,
  type CloudTemporalRateLimitOptions,
  type CloudTemporalRateLimiter,
} from "./cloudTemporalRateLimit";

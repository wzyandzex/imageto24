/**
 * Pipeline type definitions — the injectable seam for the image upscaler.
 *
 * Per ADR-0001 (browser-only architecture) and the PRD testing decisions, every
 * environment-bound concern (Canvas/OffscreenCanvas, ONNX Runtime, IndexedDB,
 * model fetch, format codecs) is modelled here as an injectable interface so the
 * pipeline functions run under Vitest in Node without a browser. Pipeline
 * functions must never reach for a global; they receive their environment through
 * these dependency objects.
 *
 * Domain terms follow `CONTEXT.md`: see "Upscale", "Enhance (AI mode)",
 * "Interpolate (faithful mode)", "Target resolution tier", "Upscale factor",
 * "Content type", and "Device capability check".
 */

/** The project's in-memory image representation: RGBA pixels. */
export interface ImageData {
  readonly width: number;
  readonly height: number;
  /** RGBA pixel buffer, length === width * height * 4. */
  readonly data: Uint8ClampedArray;
}

/** Image formats the pipeline understands, for both decode and encode. */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif";

/** A named resolution goal (see CONTEXT.md "Target resolution tier"). */
export type ResolutionTier = "1080p" | "2K" | "4K";

/** Long-edge pixel target for each resolution tier. */
export const TIER_LONG_EDGE: Readonly<Record<ResolutionTier, number>> = {
  "1080p": 1920,
  "2K": 2560,
  "4K": 3840,
};

/** The integer multiple the model/algorithm natively operates at. */
export type UpscaleFactor = 2 | 3 | 4;

/** Processing mode (see CONTEXT.md "Faithful mode" / "AI mode"). */
export type ProcessingMode = "faithful" | "ai";

/** Content category that routes AI model selection (see CONTEXT.md "Content type"). */
export type ContentType = "photo" | "anime";

/** An AI model the AI-mode upscaler can run. */
export interface AiModel {
  readonly id: string;
  readonly content: ContentType;
}

/**
 * What the user asked for. Either a named tier, an explicit factor, or a custom
 * long-edge pixel target. Exactly one variant is meaningful; consumers should
 * treat the union as discriminated by which field is present.
 */
export interface TargetSpec {
  readonly tier?: ResolutionTier;
  readonly factor?: UpscaleFactor;
  readonly customLongEdge?: number;
}

/** Result of resolving a user goal into an upscale factor. */
export interface UpscaleFactorResult {
  /**
   * The integer multiple the upscaler will operate at. Always one of 2/3/4.
   * Absent when {@link noUpscale} is true — there is no valid upscale to perform.
   */
  readonly factor?: UpscaleFactor;
  /**
   * Boundary flag: the requested target does not exceed the source long edge, so
   * no upscale is meaningful. Callers must surface this to the user rather than
   * silently no-op'ing (PRD user story #21).
   */
  readonly noUpscale: boolean;
  /**
   * Target long edge minus the model/algorithm's native output long edge. When
   * non-zero, a final Lanczos down/up adjustment to the exact target is needed
   * after the native upscale (PRD §Resolution control, "default path").
   */
  readonly residualAdjustment: number;
}

/**
 * Decodes an encoded file into pixel data. Environment-bound (Canvas /
 * OffscreenCanvas / browser-native decoders); always injected, never global.
 */
export interface DecoderDeps {
  decode(buffer: ArrayBuffer, format: ImageFormat): Promise<ImageData>;
}

/** Encodes pixel data back into a file. Environment-bound; always injected. */
export interface EncoderDeps {
  encode(
    imageData: ImageData,
    options: EncodeOptions,
  ): Promise<ArrayBuffer>;
}

/** Exact target dimensions, used to land an upscale precisely on a tier's long edge. */
export interface ExactTargetSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Runs the upscale. In faithful mode this is Lanczos interpolation
 * (deterministic, lossless); in AI mode it is ONNX model inference via WebGPU.
 * Both are environment-bound and arrive as injected implementations.
 *
 * When {@link UpscaleOptions.exactTargetSize} is provided, the upscaler performs
 * the integer-factor native upscale and then a final Lanczos resize to the exact
 * target, honouring the tier's long edge precisely (PRD §Resolution control).
 */
export interface UpscalerDeps {
  upscale(imageData: ImageData, options: UpscaleOptions): Promise<ImageData>;
}

/** Options for {@link UpscalerDeps.upscale}. */
export interface UpscaleOptions {
  readonly mode: ProcessingMode;
  readonly factor: UpscaleFactor;
  readonly model?: AiModel;
  /**
   * When set, the upscaler adjusts its native integer output to exactly these
   * dimensions (the tier target). Absent for the explicit-factor / no-residual
   * path, where the native output already matches the goal.
   */
  readonly exactTargetSize?: ExactTargetSize;
}

/** Loads (and caches) an AI model, lazily. Environment-bound (fetch / IndexedDB). */
export interface ModelLoaderDeps {
  loadModel(content: ContentType): Promise<AiModel>;
}

/**
 * Detects WebGPU support and an estimated memory budget for AI work
 * (see CONTEXT.md "Device capability check"). Environment-bound; always injected.
 */
export interface CapabilityDetector {
  checkDeviceCapability(): Promise<DeviceCapability>;
}

/** Output of the device capability check. */
export interface DeviceCapability {
  readonly webgpu: boolean;
  /**
   * Estimated bytes available for AI work, or 0 when no estimate is possible
   * (`navigator.deviceMemory` is Chromium-only). With WebGPU present, 0 is
   * treated as "unknown" by `resolveAiCapability` — AI is permitted and the
   * runtime is left to enforce per-image limits. Without WebGPU, 0 simply
   * reflects that no AI work can run at all.
   */
  readonly memBudget: number;
}

/** Options for {@link EncoderDeps.encode}. */
export interface EncodeOptions {
  readonly format: ImageFormat;
  readonly lossless: boolean;
  readonly preserveExif: boolean;
}

/** Options that drive the orchestrator. */
export interface ProcessImageOptions {
  readonly mode: ProcessingMode;
  readonly target: TargetSpec;
  readonly outputFormat: ImageFormat;
  readonly lossless: boolean;
  readonly preserveExif: boolean;
  readonly contentType?: ContentType;
}

/** Metadata returned alongside the processed buffer. */
export interface ProcessImageMeta {
  readonly mode: ProcessingMode;
  readonly factor?: UpscaleFactor;
  readonly width: number;
  readonly height: number;
  readonly noUpscale: boolean;
}

/** The orchestrator's result. */
export interface ProcessImageResult {
  readonly buffer: ArrayBuffer;
  readonly meta: ProcessImageMeta;
}

/**
 * Bundle of every environment-bound dependency the orchestrator threads through.
 * Injecting a single object keeps the call sites readable and the seam explicit.
 */
export interface PipelineDeps {
  readonly decoder: DecoderDeps;
  readonly encoder: EncoderDeps;
  readonly upscaler: UpscalerDeps;
  readonly modelLoader: ModelLoaderDeps;
  readonly capability: CapabilityDetector;
}

/**
 * The decoded image and detected/assumed content type, threaded from decode into
 * the rest of the pipeline. Classification lands in a later slice; here the type
 * is carried so the orchestrator signature is stable.
 */
export interface DecodedImage {
  readonly imageData: ImageData;
  readonly format: ImageFormat;
  readonly contentType: ContentType;
}

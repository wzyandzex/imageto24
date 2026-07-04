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

/**
 * Image formats the pipeline understands, for both decode and encode.
 *
 * `heic` is **input-only**: the browser has no native HEIC decoder, so HEIC is
 * converted to a PNG bitmap via `heic2any` inside the decoder seam before the
 * rest of the pipeline ever sees it (issue #15, PRD §HEIC input). No browser-side
 * HEIC encoder exists, so output is never HEIC (PRD §Out of scope).
 */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "heic";

/** Animated decoder dispatch formats, including APNG before upload routing lands. */
export type AnimatedImageFormat = ImageFormat | "apng";

/**
 * The subset of {@link ImageFormat} a user may select for *output* (issue #10).
 * AVIF, GIF, and HEIC are input-only — Canvas cannot reliably encode AVIF/GIF in
 * every target browser, and no viable browser-side HEIC encoder exists. Defined
 * as a type alias (not a literal re-declaration) so the two stay in sync if the
 * input set ever changes.
 */
export type OutputFormat = "png" | "webp" | "jpeg";

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

/**
 * A live AI inference session — the environment-bound object that actually runs
 * model inference (ONNX Runtime Web `InferenceSession` in the browser). Modelled
 * as a minimal interface so the pure dispatch logic can be tested in Node with a
 * stub session that never touches a real GPU. The session is created by the
 * (environment-bound) model loader and carried through the pipeline on the
 * {@link AiModel}; it is absent on models that have not yet been loaded.
 */
export interface AiInferenceSession {
  /**
   * Run inference. `feeds` is a map of input tensor name → typed numeric array,
   * matching the model's input signature. Returns a map of output tensor name →
   * typed numeric array. Both shapes/strides are negotiated out-of-band (the AI
   * upscaler knows the Real-ESRGAN contract); this interface stays generic so it
   * can stand in for any ONNX session.
   */
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Release the underlying session/resources. Called after each run. */
  release(): Promise<void> | void;
}

/** An AI model the AI-mode upscaler can run. */
export interface AiModel {
  readonly id: string;
  readonly content: ContentType;
  /**
   * The native integer multiple this model scales by (Real-ESRGAN always 4×).
   * The orchestrator may request a smaller factor; the AI upscaler runs the
   * model at its native factor and then Lanczos-resizes to the requested target.
   */
  readonly nativeFactor: UpscaleFactor;
  /**
   * The live inference session, set once the model has been loaded. Absent on a
   * bare descriptor before load; the AI upscaler throws if a run is attempted
   * without one (a loud failure beats silently fabricating output).
   */
  readonly session?: AiInferenceSession;
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

/**
 * One decoded frame of an animated image (issue #18, v3 generalization). The
 * {@link imageData} is the full-canvas composited RGBA — disposal/offset/
 * transparency already applied by the decoder — so each frame is an independent
 * still the upscaler can run on unmodified. {@link delay} and
 * {@link disposalType} are carried through verbatim so the re-encode preserves
 * timing and disposal behaviour (PRD stories #11/#12).
 */
export interface DecodedAnimatedFrame {
  readonly imageData: ImageData;
  /** Frame delay in milliseconds, as the decoder reports it. */
  readonly delay: number;
  /** Original disposal method (0/1/2/3 for GIF), carried through for re-encode. */
  readonly disposalType: number;
}

/**
 * Decodes an animated image into its per-frame full-canvas {@link ImageData}.
 * Environment-bound (gifuct-js for GIF in v2, WebCodecs for WebP in v3,
 * lazy-loaded); always injected. The pure orchestrator never touches a codec
 * directly — it sees only frames (v3 generalization, issue #24).
 *
 * The {@link format} parameter (issue #26) lets one format-aware dispatcher
 * decode multiple container formats behind a single seam, with format
 * dispatch happening inside the adapter (PRD: "format dispatch happens inside
 * the adapter"). The orchestrator forwards the detected {@link ImageFormat}
 * verbatim; it never branches on it.
 */
export interface AnimatedDecoderDeps {
  /**
   * @param buffer the encoded animated container's raw bytes.
   * @param format the detected {@link ImageFormat} (defaults to `"gif"` for
   *   backward compatibility with the v2 GIF-only codec, which ignores it).
   */
  decodeAnimated(
    buffer: ArrayBuffer,
    format?: AnimatedImageFormat,
  ): Promise<readonly DecodedAnimatedFrame[]>;
}

/** Options for {@link AnimatedEncoderDeps.encodeAnimated}. */
export interface AnimatedEncodeOptions {
  readonly width: number;
  readonly height: number;
}

/**
 * Re-encodes a sequence of enhanced frames into a playable animated container.
 * Environment-bound (gifenc for GIF in v2, UPNG.js for APNG in v3,
 * lazy-loaded); always injected. The encoder owns the format-specific
 * quantization (256-colour for GIF per ADR-0006; none for APNG) and per-frame
 * timing + disposal; the orchestrator hands it the upscaled frames + their
 * original delays and disposal methods (v3 generalization, issue #24).
 */
export interface AnimatedEncoderDeps {
  encodeAnimated(
    frames: ReadonlyArray<{
      imageData: ImageData;
      delay: number;
      /**
       * Disposal method (0/1/2/3 for GIF), carried through from the decode so the
       * re-encoded container composites identically on playback (PRD story #12).
       * A full-canvas composited frame can usually leave disposal at the default,
       * but passing it through keeps the round-trip faithful.
       */
      disposalType: number;
    }>,
    options: AnimatedEncodeOptions,
  ): Promise<ArrayBuffer>;
}

/** Exact target dimensions, used to land an upscale precisely on a tier's long edge. */
export interface ExactTargetSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The faithful (Lanczos) upscaler seam. Does pure interpolation — no AI model,
 * no mode dispatch (architecture review candidate #3 split this out of the
 * former dispatcher). Each adapter owns exactly one mode's implementation.
 */
export interface FaithfulUpscalerDeps {
  upscale(imageData: ImageData, options: FaithfulUpscaleOptions): Promise<ImageData>;
}

/** Options for {@link FaithfulUpscalerDeps.upscale}. */
export interface FaithfulUpscaleOptions {
  readonly factor: UpscaleFactor;
  /**
   * When set, the upscaler performs the integer-factor native upscale and then
   * a final Lanczos resize to the exact target, honouring the tier's long edge
   * precisely (PRD §Resolution control). Absent for the explicit-factor path,
   * where the native output already matches the goal.
   */
  readonly exactTargetSize?: ExactTargetSize;
}

/**
 * The AI (Real-ESRGAN / ONNX Runtime) upscaler seam. Reconstructs detail via
 * model inference — non-lossless by nature. Requires a loaded model; the
 * orchestrator loads it lazily before calling.
 */
export interface AiUpscalerDeps {
  upscale(imageData: ImageData, options: AiAdapterOptions): Promise<ImageData>;
}

/** Options for {@link AiUpscalerDeps.upscale}. The model is required. */
export interface AiAdapterOptions {
  readonly factor: UpscaleFactor;
  readonly model: AiModel;
  /**
   * When set, the upscaler adjusts its native integer output to exactly these
   * dimensions (the tier target). Absent for the explicit-factor / no-residual
   * path, where the native output already matches the goal.
   */
  readonly exactTargetSize?: ExactTargetSize;
}

/**
 * The blending upscaler seam (v4, ADR-0008). Implements enhancement strength as a
 * per-pixel alpha blend of the AI and faithful upscaled outputs, composing the two
 * existing seams (from #3) rather than forking them. The same `factor`, `model`,
 * and `exactTargetSize` are forwarded to both inner upscalers so their outputs land
 * at an identical resolution before blending.
 *
 * Invoked by the orchestrator only when enhancement strength is below 100% (α < 1);
 * at α = 1 the orchestrator calls {@link AiUpscalerDeps} directly, skipping the
 * redundant faithful pass. See CONTEXT.md "Blending upscaler".
 */
export interface BlendingUpscalerDeps {
  upscale(imageData: ImageData, options: BlendingUpscaleOptions): Promise<ImageData>;
}

/** Options for {@link BlendingUpscalerDeps.upscale}. */
export interface BlendingUpscaleOptions {
  readonly factor: UpscaleFactor;
  readonly model: AiModel;
  /**
   * The blend ratio α ∈ [0,1]: `out = α × aiUpscaled + (1 − α) × lanczosUpscaled`.
   * α = 0 yields the faithful output, α = 1 the AI output. See ADR-0008.
   */
  readonly alpha: number;
  /**
   * When set, forwarded to both inner upscalers so their native integer outputs
   * are adjusted to exactly these dimensions before blending. Absent for the
   * explicit-factor path.
   */
  readonly exactTargetSize?: ExactTargetSize;
}

/**
 * Progress reporting for a lazy model load. Fires when a model download starts,
 * repeatedly as bytes stream in, and once when the load is ready. The orchestrator
 * does not interpret the values — it forwards them to its own caller (the UI)
 * so the user understands why the first AI run waits on a ~65MB download
 * (PRD user story #17, issue #6). Absent/no callback for the no-download
 * (cached) path.
 */
export interface ModelLoadProgress {
  /** "downloading" while fetching the weights, "ready" once the session is live. */
  readonly phase: "downloading" | "ready";
  /** Bytes received so far, when known. */
  readonly received?: number;
  /** Total expected bytes, when the server reported Content-Length. */
  readonly total?: number;
}

/**
 * Per-frame progress for the animated-GIF path (issue #18, PRD story #10). Fires
 * once after each frame completes its upscale, so the UI can show the GIF
 * advancing frame-by-frame. 1-based `current` against `total` (the frame count
 * from the decode); the sequence is in frame order.
 */
export interface FrameProgress {
  readonly current: number;
  readonly total: number;
}

/** Per-frame progress callback threaded through `processAnimated`. */
export type FrameProgressCb = (p: FrameProgress) => void;

/**
 * Progress callback threaded through the lazy model load. Optional; pure
 * orchestration tests pass nothing and the loader still completes.
 */
export type ModelLoadProgressCb = (p: ModelLoadProgress) => void;

/** Loads (and caches) an AI model, lazily. Environment-bound (fetch / IndexedDB). */
export interface ModelLoaderDeps {
  loadModel(content: ContentType, onProgress?: ModelLoadProgressCb): Promise<AiModel>;
}

/**
 * Detects WebGPU support, the AI memory budget, and WebCodecs support
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
  /**
   * Whether the WebCodecs `ImageDecoder` API is available. This is the gate for
   * the high-fidelity animated-output path (ADR-0007): a WebCodecs-capable
   * device decodes animated WebP/GIF frames losslessly and re-encodes them as
   * true-colour APNG; a device without WebCodecs falls back to wasm decode +
   * 256-colour GIF output. The UI surfaces this honestly (issue #29): the output
   * format is device-determined, not user-selected, for animated input.
   * Optional (defaults to absent ⇒ falsy ⇒ GIF degrade): the AI-capability
   * tests and fixtures don't care about WebCodecs, so they omit it; only the
   * browser probe and the animated-output UI read it.
   */
  readonly webCodecs?: boolean;
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
  /**
   * The user's chosen output format (issue #10). Constrained to the v1 output
   * matrix (PNG / WebP / JPEG); AVIF and GIF are input-only. The orchestrator
   * further constrains this for faithful mode (PNG / lossless WebP) via
   * {@link resolveOutput} — never trust the caller to honour the lossless promise.
   */
  readonly outputFormat: OutputFormat;
  readonly lossless: boolean;
  readonly preserveExif: boolean;
  readonly contentType?: ContentType;
  /**
   * Enhancement strength as the alpha blend ratio α ∈ [0,1] (v4, ADR-0008).
   * AI-mode only: α = 1 (the default) runs the AI upscaler directly; α < 1 runs
   * the {@link BlendingUpscalerDeps}, blending the AI and faithful outputs so the
   * result keeps more of the original's texture. The UI surfaces this as a 0–100%
   * slider; absent ⇒ 1 (existing behaviour unchanged). Ignored in faithful mode.
   */
  readonly alpha?: number;
}

/** Metadata returned alongside the processed buffer. */
export interface ProcessImageMeta {
  readonly mode: ProcessingMode;
  readonly factor?: UpscaleFactor;
  readonly width: number;
  readonly height: number;
  readonly noUpscale: boolean;
  /**
   * Frame count, set only by the animated-GIF path ({@link processAnimated}).
   * Absent for a still run (`processImage`). Surfaced so the UI can confirm the
   * output animation has the same frame count as the input (PRD story #17).
   */
  readonly frameCount?: number;
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
  readonly faithfulUpscaler: FaithfulUpscalerDeps;
  readonly aiUpscaler: AiUpscalerDeps;
  /**
   * The blending upscaler (v4, ADR-0008). Composes {@link AiUpscalerDeps} and
   * {@link FaithfulUpscalerDeps} into a per-pixel alpha blend behind one seam.
   * `processImage` calls it only when AI mode is selected with enhancement
   * strength below 100% (α < 1); at α = 1 it calls {@link aiUpscaler} directly,
   * skipping the redundant faithful pass. Optional on the bundle so the existing
   * still-path tests continue to build without it — the orchestrator throws
   * loudly if it is absent when a blend is actually requested (wiring in #40).
   */
  readonly blendingUpscaler?: BlendingUpscalerDeps;
  readonly modelLoader: ModelLoaderDeps;
  readonly capability: CapabilityDetector;
  /**
   * Animated-image codec (issues #18/#24). Only the {@link processAnimated}
   * path consumes these; `processImage` never touches them. They are optional on
   * the bundle so the still path's tests can omit them — `processAnimated`
   * throws loudly if they are absent. Format-specific (GIF/WebP/APNG); the
   * generalization in #24 made them format-agnostic interfaces.
   */
  readonly animatedDecoder?: AnimatedDecoderDeps;
  readonly animatedEncoder?: AnimatedEncoderDeps;
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

/**
 * Animated-image orchestration (issue #18) — the real per-frame counterpart to
 * {@link processImage}.
 *
 * Per the v2 PRD ("Two entry points, one router"), the UI detects a multi-frame
 * GIF on upload and routes it here instead of {@link processImage}. This
 * function carries the GIF through its full lifecycle:
 *
 *   1. decode    — gifuct-js (via {@link AnimatedGifDecoderDeps}) → full-canvas
 *                  ImageData per frame, disposal/offset/transparency applied.
 *   2. factor    — resolved from the GIF canvas + the user's target (the same
 *                  {@link computeUpscaleFactor} the still path uses).
 *   3. upscale   — frame loop, per mode (ADR-0006):
 *                    - faithful: every frame → faithfulUpscaler
 *                    - ai:       frame 0 → aiUpscaler; frames 1..n → faithful
 *                  Each frame carries its original delay (timing preserved,
 *                  PRD story #11). Per-frame progress fires after each frame.
 *   4. encode    — gifenc (via {@link AnimatedGifEncoderDeps}) → a playable
 *                  animated GIF (256-colour per-frame, transparency preserved,
 *                  PRD stories #8/#12).
 *
 * `processImage` is untouched — a single-frame still never enters this path.
 * The output is always a GIF (the only animated output container v2 ships);
 * the caller's `outputFormat` is irrelevant for an animated input and ignored.
 *
 * The 256-colour GIF ceiling is an inherent limit (ADR-0006): the faithful
 * upscale's full-colour output is quantized per-frame. That's the documented
 * trade of GIF's universal playback; no workaround in v2.
 */
import { computeUpscaleFactor, tierToLongEdge } from "./computeUpscaleFactor";
import { dimsForLongEdge } from "./lanczos";
import { estimateAiMemoryCost, resolveAiCapability } from "./capability";
import type {
  AnimatedImageFormat,
  AiModel,
  ContentType,
  ExactTargetSize,
  FrameProgressCb,
  ImageData,
  ModelLoadProgressCb,
  PipelineDeps,
  ProcessImageOptions,
  ProcessImageResult,
} from "./types";
import { classifyContent } from "./contentClassifier";

/**
 * Process an animated GIF end-to-end.
 *
 * @param deps    injected environment-bound dependencies. `animatedDecoder` and
 *   `animatedEncoder` are required here; the function throws loudly if absent
 *   (the still path omits them).
 * @param file    the encoded input. `format` is `gif` for the v2 animated path.
 * @param options mode, target, output format, EXIF, optional content-type
 *   override. `outputFormat` is ignored — the output is always a GIF.
 * @param onModelProgress optional AI model-download callback, fired once during
 *   the first (AI) frame so the UI's first-use indicator still works.
 * @param onFrameProgress optional per-frame callback, fired after each frame's
 *   upscale (PRD story #10).
 */
export async function processAnimated(
  deps: PipelineDeps,
  file: { buffer: ArrayBuffer; format: AnimatedImageFormat },
  options: ProcessImageOptions,
  onModelProgress?: ModelLoadProgressCb,
  onFrameProgress?: FrameProgressCb,
): Promise<ProcessImageResult> {
  if (!deps.animatedDecoder || !deps.animatedEncoder) {
    // The animated codec is required here. The bundle normally carries it; if
    // a caller omitted it, fail loudly rather than silently degrading to a
    // still (ADR-0002 honest-degradation principle).
    throw new Error("processAnimated requires animatedDecoder and animatedEncoder");
  }

  // 1. Decode — full-canvas composited ImageData frames. The decoder is a
  // format-aware dispatcher (issue #26): it routes by `file.format` to the
  // right container's per-frame decode (gifuct-js for GIF, WebCodecs ImageDecoder
  // or a wasm fallback for WebP). The orchestrator never branches on format.
  const frames = await deps.animatedDecoder.decodeAnimated(file.buffer, file.format);
  if (frames.length === 0) {
    throw new Error("Animated image contained no decodable frames");
  }

  // The canvas is the logical screen; every frame shares it.
  const canvasWidth = frames[0].imageData.width;
  const canvasHeight = frames[0].imageData.height;

  // 2. Resolve the upscale factor from the canvas (same logic as the still path).
  const factorResult = computeUpscaleFactor(
    { width: canvasWidth, height: canvasHeight },
    options.target,
  );

  // Resolve the AI capability gate so an unsupported device lands on faithful
  // (ADR-0002 graceful degradation) — same two-stage check the still path runs:
  // (1) WebGPU presence, (2) memory budget vs. the AI cost at this factor.
  let mode = options.mode;
  if (mode === "ai") {
    const capability = await deps.capability.checkDeviceCapability();
    if (!capability.webgpu) {
      mode = "faithful";
    } else if (
      !factorResult.noUpscale &&
      factorResult.factor !== undefined
    ) {
      // Memory-budget gate (issue #5): estimate the AI cost from the GIF canvas
      // and the resolved factor, and refuse AI if it would exceed the budget.
      // The AI path only processes frame 0 (ADR-0006), so the cost is the
      // single-frame upscale — the same shape the still path gates on.
      const aiCost = estimateAiMemoryCost(
        canvasWidth * canvasHeight,
        factorResult.factor,
      );
      const decision = resolveAiCapability(capability, aiCost);
      if (!decision.canRunAi) mode = "faithful";
    }
  }

  // The residual → exact target size, identical to processImage's resolution.
  let exactTargetSize: ExactTargetSize | undefined;
  if (!factorResult.noUpscale && factorResult.residualAdjustment !== 0) {
    const targetLongEdge =
      options.target.tier !== undefined
        ? tierToLongEdge(options.target.tier)
        : options.target.customLongEdge;
    if (targetLongEdge !== undefined) {
      exactTargetSize = dimsForLongEdge(
        canvasWidth,
        canvasHeight,
        targetLongEdge,
      );
    }
  }

  // Output canvas dims: the upscaled (or boundary-passthrough) frame size.
  let outWidth = canvasWidth;
  let outHeight = canvasHeight;
  let factorMeta = factorResult.factor;
  if (!factorResult.noUpscale && factorResult.factor !== undefined) {
    const scaled = canvasWidth * factorResult.factor;
    if (exactTargetSize) {
      outWidth = exactTargetSize.width;
      outHeight = exactTargetSize.height;
    } else {
      outWidth = scaled;
      outHeight = canvasHeight * factorResult.factor;
    }
  } else {
    factorMeta = undefined;
  }

  // 3. Upscale every frame, in order.
  //
  // (AI only) lazy model load before the first frame, routed by content type —
  // a manual override wins (ADR-0003), otherwise the classifier inspects frame 0.
  let model: AiModel | undefined;
  if (mode === "ai" && !factorResult.noUpscale && factorResult.factor !== undefined) {
    const contentType: ContentType =
      options.contentType ?? classifyContent(frames[0].imageData);
    model = await deps.modelLoader.loadModel(contentType, onModelProgress, options.modelId);
  }

  const enhanced: { imageData: ImageData; delay: number; disposalType: number }[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];

    let output: ImageData;
    if (factorResult.noUpscale || factorResult.factor === undefined) {
      // Boundary: target not larger than source. Pass the frame through
      // unchanged (no upscale), but keep it in the animation.
      output = frame.imageData;
    } else if (mode === "ai" && i === 0) {
      // ADR-0006: AI enhances frame one only; the remaining frames use faithful.
      output = await deps.aiUpscaler.upscale(frame.imageData, {
        factor: factorResult.factor,
        model: model!,
        exactTargetSize,
      });
    } else if (mode === "ai") {
      // AI mode, frames 1..n: faithful per-frame (ADR-0006's contract).
      output = await deps.faithfulUpscaler.upscale(frame.imageData, {
        factor: factorResult.factor,
        exactTargetSize,
      });
    } else {
      // Faithful mode: every frame through the same path.
      output = await deps.faithfulUpscaler.upscale(frame.imageData, {
        factor: factorResult.factor,
        exactTargetSize,
      });
    }

    // Carry the original delay + disposal through so the re-encoded GIF keeps
    // the animation's timing (PRD story #11) and composites identically (#12).
    enhanced.push({
      imageData: output,
      delay: frame.delay,
      disposalType: frame.disposalType,
    });

    // Per-frame progress fires after each frame completes (PRD story #10).
    onFrameProgress?.({ current: i + 1, total: frames.length });
  }

  // 4. Encode — gifenc re-assembles the frames into a playable animated GIF.
  const buffer = await deps.animatedEncoder.encodeAnimated(
    enhanced,
    { width: outWidth, height: outHeight },
  );

  return {
    buffer,
    meta: {
      mode,
      factor: factorMeta,
      width: outWidth,
      height: outHeight,
      noUpscale: factorResult.noUpscale,
      frameCount: frames.length,
    },
  };
}

/**
 * The orchestrator: composes the pipeline end-to-end, threading the injected
 * dependencies through every environment-bound step.
 *
 * Flow (PRD §"The processing pipeline"):
 *   1. checkDeviceCapability      — gates AI mode (graceful degradation, ADR-0002)
 *   2. decode                     — encoded file → ImageData
 *   3. computeUpscaleFactor       — resolve the user goal; honour the noUpscale boundary
 *   4. (AI only) loadModel        — lazy model load, routed by content type
 *   5. upscale                    — faithful or AI, via the injected upscaler
 *   6. encode                     — ImageData → file, honouring format/lossless/EXIF
 *
 * This slice orchestrates the seam; the injected implementations are stubs.
 */
import { classifyContent } from "./contentClassifier";
import { computeUpscaleFactor, tierToLongEdge } from "./computeUpscaleFactor";
import { dimsForLongEdge } from "./lanczos";
import { estimateAiMemoryCost, resolveAiCapability } from "./capability";
import { resolveOutput } from "./formats";
import type {
  AiModel,
  ExactTargetSize,
  ImageFormat,
  ModelLoadProgressCb,
  PipelineDeps,
  ProcessImageOptions,
  ProcessImageResult,
  UpscaleFactor,
} from "./types";

/**
 * Process a single image through the pipeline.
 *
 * @param deps   injected environment-bound dependencies (codec, runtime, models).
 * @param file   the encoded input.
 * @param options mode, target, output format, EXIF, optional content-type override.
 * @param onModelProgress optional callback fired during a lazy AI model download
 *   (issue #6) so the UI can show an honest first-use loading indicator. Ignored
 *   in faithful mode and on the cached-model path.
 */
export async function processImage(
  deps: PipelineDeps,
  file: { buffer: ArrayBuffer; format: ImageFormat },
  options: ProcessImageOptions,
  onModelProgress?: ModelLoadProgressCb,
): Promise<ProcessImageResult> {
  // 1. Capability check — gates AI mode. When the device can't run AI, faithful
  //    mode is the available path (ADR-0002). We do not hard-error.
  const capability = await deps.capability.checkDeviceCapability();

  // WebGPU presence is known before we even decode; gate immediately. The
  // memory-budget half waits until the source dimensions (and thus the AI cost)
  // are known — see step 3 below.
  let mode = options.mode;
  if (mode === "ai" && !capability.webgpu) {
    // Graceful degradation: no WebGPU ⇒ AI unavailable.
    mode = "faithful";
  }

  // Resolve the output format *after* the capability gate may have downgraded
  // AI → faithful. Faithful mode must never emit a lossy result, so a JPEG or
  // lossy-WebP choice is coerced here as a defensive backstop (issue #10). The
  // UI restricts the choices too; the orchestrator never trusts the caller to
  // honour the lossless promise.
  const resolved = resolveOutput(mode, options.outputFormat, options.lossless);

  // 2. Decode.
  const imageData = await deps.decoder.decode(file.buffer, file.format);

  // 3. Resolve the upscale factor (or the noUpscale boundary).
  const factorResult = computeUpscaleFactor(
    { width: imageData.width, height: imageData.height },
    options.target,
  );

  // Memory-budget gate (issue #5): now that the source size and resolved factor
  // are known, estimate the AI cost and refuse AI mode if it would exceed the
  // device's budget. Faithful mode is the offered alternative.
  if (
    mode === "ai" &&
    !factorResult.noUpscale &&
    factorResult.factor !== undefined
  ) {
    const aiCost = estimateAiMemoryCost(
      imageData.width * imageData.height,
      factorResult.factor,
    );
    const decision = resolveAiCapability(capability, aiCost);
    if (!decision.canRunAi) {
      mode = "faithful";
    }
  }

  // Boundary rule: target not larger than source — surface to the caller via meta
  // and skip the upscale, but still encode the (unchanged) image so the caller
  // gets a usable file. (PRD #21: tell the user; don't silently no-op.)
  let output = imageData;
  let factorMeta: UpscaleFactor | undefined = factorResult.factor;

  if (!factorResult.noUpscale && factorResult.factor !== undefined) {
    // 4. (AI only) lazy model load, routed by content type. A manual override
    //    always wins (ADR-0003 safety net); otherwise the lightweight classifier
    //    inspects the decoded pixels and returns in milliseconds.
    let model: AiModel | undefined;
    if (mode === "ai") {
      const contentType =
        options.contentType ?? classifyContent(imageData);
      model = await deps.modelLoader.loadModel(contentType, onModelProgress, options.modelId);
    }

    // When the tier/custom target's long edge differs from the native integer
    // output, pass the exact target size so the upscaler applies a final Lanczos
    // resize to land precisely on it (PRD §Resolution control, default path).
    let exactTargetSize: ExactTargetSize | undefined;
    if (factorResult.residualAdjustment !== 0) {
      const targetLongEdge = options.target.tier !== undefined
        ? tierToLongEdge(options.target.tier)
        : options.target.customLongEdge;
      if (targetLongEdge !== undefined) {
        exactTargetSize = dimsForLongEdge(
          imageData.width,
          imageData.height,
          targetLongEdge,
        );
      }
    }

    // 5. Upscale — one adapter per mode (architecture review candidate #3).
    //    The orchestrator already knows `mode` (it gates model loading on it),
    //    so dispatching here concentrates the decision where it already lives.
    //    Each adapter's options carry only what that mode actually consumes:
    //    faithful ignores the model entirely; ai requires it.
    //
    //    Enhancement strength (ADR-0008, issue #40): in AI mode, an alpha < 1
    //    means blend the AI output with the faithful output instead of running
    //    pure AI. At alpha = 1 (the default) the orchestrator calls the AI
    //    upscaler directly, skipping the redundant faithful pass — so the
    //    default path is byte-identical to v1–v3. The blending upscaler composes
    //    the two existing seams (#3/#38); it never forks them.
    if (mode === "ai") {
      const alpha = options.alpha ?? 1;
      const useBlend = alpha < 1 && deps.blendingUpscaler !== undefined;
      if (useBlend) {
        output = await deps.blendingUpscaler.upscale(imageData, {
          factor: factorResult.factor,
          model: model!,
          alpha,
          exactTargetSize,
        });
      } else {
        output = await deps.aiUpscaler.upscale(imageData, {
          factor: factorResult.factor,
          model: model!,
          exactTargetSize,
        });
      }
    } else {
      output = await deps.faithfulUpscaler.upscale(imageData, {
        factor: factorResult.factor,
        exactTargetSize,
      });
    }
  } else {
    // No valid upscale — factor is undefined; reflect that in the metadata.
    factorMeta = undefined;
  }

  // 6. Encode. The resolved format/lossless honour the mode's constraints —
  //    faithful mode never emits lossy output (issue #10, resolved above).
  const buffer = await deps.encoder.encode(output, {
    format: resolved.format,
    lossless: resolved.lossless,
    preserveExif: options.preserveExif,
  });

  return {
    buffer,
    meta: {
      mode,
      factor: factorMeta,
      width: output.width,
      height: output.height,
      noUpscale: factorResult.noUpscale,
    },
  };
}

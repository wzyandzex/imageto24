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
import { checkDeviceCapability } from "./steps";
import { classify } from "./steps";
import { decode } from "./steps";
import { encode } from "./steps";
import { upscale } from "./steps";
import { computeUpscaleFactor, tierToLongEdge } from "./computeUpscaleFactor";
import { dimsForLongEdge } from "./lanczos";
import type {
  AiModel,
  ContentType,
  ExactTargetSize,
  ImageFormat,
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
 */
export async function processImage(
  deps: PipelineDeps,
  file: { buffer: ArrayBuffer; format: ImageFormat },
  options: ProcessImageOptions,
): Promise<ProcessImageResult> {
  // 1. Capability check — gates AI mode. When the device can't run AI, faithful
  //    mode is the available path (ADR-0002). We do not hard-error.
  const capability = await checkDeviceCapability(() =>
    deps.capability.checkDeviceCapability(),
  );

  let mode = options.mode;
  if (mode === "ai" && !capability.webgpu) {
    // Graceful degradation: AI unavailable → faithful mode.
    mode = "faithful";
  }

  // 2. Decode.
  const imageData = await decode(deps.decoder, file.buffer, file.format);

  // 3. Resolve the upscale factor (or the noUpscale boundary).
  const factorResult = computeUpscaleFactor(
    { width: imageData.width, height: imageData.height },
    options.target,
  );

  // Boundary rule: target not larger than source — surface to the caller via meta
  // and skip the upscale, but still encode the (unchanged) image so the caller
  // gets a usable file. (PRD #21: tell the user; don't silently no-op.)
  let output = imageData;
  let factorMeta: UpscaleFactor | undefined = factorResult.factor;

  if (!factorResult.noUpscale && factorResult.factor !== undefined) {
    // 4. (AI only) lazy model load, routed by content type.
    let model: AiModel | undefined;
    if (mode === "ai") {
      const contentType: ContentType = classify(options.contentType);
      model = await deps.modelLoader.loadModel(contentType);
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

    // 5. Upscale.
    output = await upscale(deps.upscaler, imageData, {
      mode,
      factor: factorResult.factor,
      model,
      exactTargetSize,
    });
  } else {
    // No valid upscale — factor is undefined; reflect that in the metadata.
    factorMeta = undefined;
  }

  // 6. Encode.
  const buffer = await encode(deps.encoder, output, {
    format: options.outputFormat,
    lossless: options.lossless,
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

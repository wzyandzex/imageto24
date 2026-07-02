/**
 * Browser-bound upscalers — one adapter per mode (architecture review candidate #3).
 *
 * The former `faithfulUpscaler` was a dispatcher: its name promised faithful
 * (Lanczos) but its body branched on `mode` and also ran AI inference. That
 * conflated two real seams into one lying interface. They are now split:
 *
 * - {@link faithfulUpscaler} — pure Lanczos interpolation. Deterministic,
 *   lossless, no model, no mode dispatch. The faithful promise lives here.
 * - {@link aiUpscaler} — pure ONNX inference via {@link aiUpscale}. Requires a
 *   loaded model (the orchestrator loads it lazily before calling); throws
 *   loudly rather than silently fabricating output if the session is missing.
 *
 * The orchestrator picks which adapter to call based on `mode` — that decision
 * was already there (it gates model loading on `mode === "ai"`), so moving the
 * dispatch out of the adapter concentrates it where the decision already lives.
 *
 * Both adapters stay free of ORT/tensor details: AI inference is delegated to
 * the pure {@link aiUpscale} core (the tested seam); faithful math is delegated
 * to {@link lanczosUpscale}/{@link lanczosResize}.
 */
import { lanczosResize, lanczosUpscale } from "../lanczos";
import { aiUpscale } from "../aiUpscale";
import { blendAlpha } from "../blendAlpha";
import type {
  AiAdapterOptions,
  AiUpscalerDeps,
  BlendingUpscaleOptions,
  BlendingUpscalerDeps,
  FaithfulUpscaleOptions,
  FaithfulUpscalerDeps,
  ImageData,
} from "../types";

/**
 * Faithful (Lanczos) upscaler. Does a native integer upscale, then a final
 * Lanczos resize to the exact tier target when one is provided. Deterministic
 * and lossless — the mathematical guarantee behind the faithful promise.
 */
export const faithfulUpscaler: FaithfulUpscalerDeps = {
  async upscale(
    image: ImageData,
    options: FaithfulUpscaleOptions,
  ): Promise<ImageData> {
    const native = lanczosUpscale(image, options.factor);
    if (options.exactTargetSize) {
      return lanczosResize(
        native,
        options.exactTargetSize.width,
        options.exactTargetSize.height,
      );
    }
    return native;
  },
};

/**
 * AI (Real-ESRGAN / ONNX Runtime) upscaler. Reconstructs detail via model
 * inference — non-lossless by nature. Requires a loaded model with an active
 * inference session; the orchestrator loads it lazily before calling.
 */
export const aiUpscaler: AiUpscalerDeps = {
  async upscale(
    image: ImageData,
    options: AiAdapterOptions,
  ): Promise<ImageData> {
    if (!options.model?.session) {
      // The orchestrator should have loaded the model before calling upscale;
      // reaching here is a programmer error, not a user-facing condition.
      throw new Error("AI mode requires a loaded model with an active inference session");
    }
    return aiUpscale(options.model.session, image, {
      factor: options.factor,
      nativeFactor: options.model.nativeFactor,
      exactTargetSize: options.exactTargetSize,
    });
  },
};

/**
 * Build a blending upscaler (v4, ADR-0008) that composes the AI and faithful
 * upscalers. It runs both on the same source — forwarding the same `factor`,
 * `model`, and `exactTargetSize` so their outputs land at an identical
 * resolution — then per-pixel blends them: `out = α × ai + (1 − α) × faithful`.
 *
 * The orchestrator calls this only when enhancement strength is below 100%
 * (α < 1); at α = 1 it calls {@link aiUpscaler} directly, skipping the redundant
 * faithful pass (ADR-0008). The blend math itself is delegated to the pure,
 * fully-tested {@link blendAlpha} so this adapter stays a thin composition.
 *
 * Factory form (rather than a singleton) because the two inner upscalers are
 * its dependencies — injected the same way the pipeline injects every other
 * environment-bound concern. The browser wiring passes the two singleton
 * adapters above; tests pass stubs.
 */
export function createBlendingUpscaler(deps: {
  aiUpscaler: AiUpscalerDeps;
  faithfulUpscaler: FaithfulUpscalerDeps;
}): BlendingUpscalerDeps {
  return {
    async upscale(
      image: ImageData,
      options: BlendingUpscaleOptions,
    ): Promise<ImageData> {
      const common = {
        factor: options.factor,
        exactTargetSize: options.exactTargetSize,
      };
      const [aiOut, faithfulOut] = await Promise.all([
        deps.aiUpscaler.upscale(image, { ...common, model: options.model }),
        deps.faithfulUpscaler.upscale(image, common),
      ]);
      return blendAlpha(aiOut, faithfulOut, options.alpha);
    },
  };
}

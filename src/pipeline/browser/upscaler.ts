/**
 * Browser-bound upscaler: routes faithful (Lanczos) and AI (Real-ESRGAN) modes.
 *
 * Faithful mode is environment-free at the core (lanczos.ts) and is wired here
 * directly. AI mode delegates to the pure {@link aiUpscale} dispatch, feeding it
 * the inference session the orchestrator already loaded onto the model — so this
 * adapter stays free of ORT/tensor details and the pure core remains the tested
 * seam. The model itself (session + native factor) arrives via `options.model`
 * from the orchestrator; if it is missing this throws loudly rather than
 * silently fabricating output.
 */
import { lanczosResize, lanczosUpscale } from "../lanczos";
import { aiUpscale } from "../aiUpscale";
import type { ImageData, UpscaleOptions, UpscalerDeps } from "../types";

export const faithfulUpscaler: UpscalerDeps = {
  async upscale(image: ImageData, options: UpscaleOptions): Promise<ImageData> {
    if (options.mode === "ai") {
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
    }

    // Faithful: native integer Lanczos upscale, then a final Lanczos resize to
    // the exact tier target when the orchestrator passed one.
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

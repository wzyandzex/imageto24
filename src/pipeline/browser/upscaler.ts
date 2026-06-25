/**
 * Browser-bound faithful upscaler: wraps the pure Lanczos core into the
 * {@link UpscalerDeps} shape.
 *
 * Faithful mode is environment-free at the core (lanczos.ts); this module only
 * adapts the (sync) Lanczos functions to the async UpscalerDeps contract and
 * applies the exact-target resize when the orchestrator requests a tier-precise
 * landing. AI mode is not implemented here (later slice) and throws so any
 * accidental invocation fails loudly rather than silently fabricating output.
 */
import { lanczosResize, lanczosUpscale } from "../lanczos";
import type { ImageData, UpscaleOptions, UpscalerDeps } from "../types";

export const faithfulUpscaler: UpscalerDeps = {
  async upscale(image: ImageData, options: UpscaleOptions): Promise<ImageData> {
    if (options.mode === "ai") {
      // AI inference lands in a later slice (ONNX Runtime Web, ADR-0003). Faithful
      // is the only implemented path here; surface this rather than no-op'ing.
      throw new Error("AI mode is not implemented in this slice");
    }

    // Native integer upscale, then a final Lanczos resize to the exact tier target
    // when the orchestrator passed one (the residual-adjustment step).
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

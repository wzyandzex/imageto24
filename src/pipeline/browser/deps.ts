/**
 * Assemble the full set of browser-bound pipeline dependencies for a single
 * image run. The source file's bytes are threaded into the encoder so EXIF can
 * be re-attached after Canvas re-encodes (issue #4: "EXIF preserved by default").
 *
 * The model loader lazily downloads Real-ESRGAN from R2 on first AI use and
 * caches it in IndexedDB (#6, ADR-0003). Faithful mode never touches it.
 */
import { browserCapabilityDetector } from "./capability";
import { browserDecoder } from "./canvasCodec";
import { browserEncoderWithSource } from "./canvasCodec";
import { aiUpscaler, createBlendingUpscaler, faithfulUpscaler } from "./upscaler";
import { loadRealEsrganModel } from "./modelLoader";
import { resolveAnimatedCodecPair } from "./animatedCodecPair";
import type { ModelLoaderDeps, PipelineDeps } from "../types";

/**
 * Browser model loader: delegates to the lazy R2 + IndexedDB ORT loader. WebGPU
 * is preferred (per ADR-0003); the device-capability gate from #5 has already
 * confirmed at least one viable EP before this is reached, so we re-probe
 * navigator.gpu here only to pick the bundle.
 */
const browserModelLoader: ModelLoaderDeps = {
  async loadModel(content, onProgress) {
    return loadRealEsrganModel(content, onProgress, true);
  },
};

/**
 * Build the PipelineDeps for processing one image in the browser.
 *
 * @param sourceBytes the original encoded file, kept so the encoder can preserve
 *   EXIF. Undefined when there is no source to copy metadata from.
 */
export function browserPipelineDeps(sourceBytes: ArrayBuffer | undefined): PipelineDeps {
  // Blending upscaler (v4, ADR-0008): composes the AI and faithful upscalers
  // behind one seam. Built once per run from the two singleton adapters above;
  // the orchestrator reaches for it only when enhancement strength < 100%.
  const blendingUpscaler = createBlendingUpscaler({ aiUpscaler, faithfulUpscaler });
  return {
    decoder: browserDecoder,
    encoder: browserEncoderWithSource(sourceBytes),
    faithfulUpscaler,
    aiUpscaler,
    blendingUpscaler,
    modelLoader: browserModelLoader,
    capability: browserCapabilityDetector,
    // Animated codec pair (v3 #25): detected per-call from WebCodecs availability.
    // ADR-0007 — the device determines the output format, not the UI. WebCodecs
    // (ImageDecoder) ⇒ the high-colour APNG path (v3-3/v3-4 plug in here); absent
    // ⇒ the GIF fallback. Both resolve to the existing GIF codec until v3-3/v3-4
    // land, so nothing breaks in the meantime.
    ...resolveAnimatedCodecPair({ webCodecs: hasWebCodecs() }),
  };
}

/**
 * Detect WebCodecs animated-image support on this call (no module-level cache,
 * per v3 grilling decision #6). `ImageDecoder` is the WebCodecs entry point for
 * decoding animated containers frame-by-frame; its presence is the capability
 * gate for the true-colour APNG output path.
 */
function hasWebCodecs(): boolean {
  return typeof ImageDecoder !== "undefined";
}

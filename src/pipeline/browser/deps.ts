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
import { faithfulUpscaler } from "./upscaler";
import { loadRealEsrganModel } from "./modelLoader";
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
  return {
    decoder: browserDecoder,
    encoder: browserEncoderWithSource(sourceBytes),
    upscaler: faithfulUpscaler,
    modelLoader: browserModelLoader,
    capability: browserCapabilityDetector,
  };
}

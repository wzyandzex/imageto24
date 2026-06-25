/**
 * Assemble the full set of browser-bound pipeline dependencies for a single
 * image run. The source file's bytes are threaded into the encoder so EXIF can
 * be re-attached after Canvas re-encodes (issue #4: "EXIF preserved by default").
 *
 * The model loader here is a stub — AI mode is not implemented in this slice; it
 * throws if reached, which the orchestrator only does in AI mode with WebGPU
 * available. The UI disables AI mode for this slice regardless.
 */
import { browserCapabilityDetector } from "./capability";
import { browserDecoder } from "./canvasCodec";
import { browserEncoderWithSource } from "./canvasCodec";
import { faithfulUpscaler } from "./upscaler";
import type { ContentType, ModelLoaderDeps, PipelineDeps } from "../types";

/** A model loader that refuses to load — AI mode is gated off in this slice. */
const aiDisabledModelLoader: ModelLoaderDeps = {
  async loadModel(_content: ContentType) {
    throw new Error("AI mode is not available in this slice");
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
    modelLoader: aiDisabledModelLoader,
    capability: browserCapabilityDetector,
  };
}

/**
 * Assemble the full set of browser-bound pipeline dependencies for a single
 * image run. The source file's bytes are threaded into the encoder so EXIF can
 * be re-attached after Canvas re-encodes (issue #4: "EXIF preserved by default").
 *
 * The model loader here is a stub — AI inference lands in the next slice (#6).
 * It throws if reached; the capability check (#5) gates the AI option in the UI
 * so this path is normally not taken. Faithful mode never touches it.
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

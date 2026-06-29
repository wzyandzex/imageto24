/**
 * Animated-image orchestration (issue #16 placeholder, sibling to
 * {@link processImage}).
 *
 * Per the v2 PRD ("Two entry points, one router"), the UI detects a multi-frame
 * GIF on upload and routes it here instead of to {@link processImage}.
 * `processImage` itself is untouched — a single-frame still never enters the
 * animated path.
 *
 * This slice delivers the **routing wiring**, not the per-frame logic. The
 * honest, first-frame fallback: the placeholder decodes only the first frame
 * (exactly what v1 did) and runs it through {@link processImage}. The user is
 * told this plainly in the UI ("treated as a still for now") rather than seeing
 * a silent freeze. The real per-frame decode (gifuct-js) + re-encode (gifenc)
 * lands in #18, replacing the body of this function without touching the seam.
 *
 * _Contradicts ADR-0006 (GIF AI first-frame-only) — but only for this slice,
 * and on purpose._ ADR-0006's contract is "AI enhances frame one; faithful
 * interpolates the *remaining* frames and the GIF is re-assembled at full
 * length." This placeholder does not re-assemble anything — it emits a single
 * still (first frame) regardless of mode, so it falls short of the contract in
 * both modes. That gap is surfaced honestly to the user ("still for now"),
 * never applied silently; #18 closes it by adding the per-frame loop and
 * gifenc re-encode. Stating the contradiction here (per `docs/agents/domain.md`
 * "Flag ADR conflicts") keeps it from reading as a silent override.
 */
import { processImage } from "./processImage";
import type {
  ImageFormat,
  ModelLoadProgressCb,
  PipelineDeps,
  ProcessImageOptions,
  ProcessImageResult,
} from "./types";

/**
 * Process an animated GIF.
 *
 * Placeholder (issue #16): falls back to first-frame-only, reusing the v1
 * {@link processImage} path. The signature mirrors {@link processImage} so the
 * worker can dispatch on the same shape, and so #18 can swap in the real
 * per-frame decode → upscale → re-encode without changing the call sites.
 *
 * The input format is always `gif` for v2 (the only animated container routed
 * here); animated WebP / APNG are detected by the UI but never reach this
 * function — they stay on the still path with an honest notice (PRD §Out of
 * scope).
 *
 * @param deps   injected environment-bound dependencies, threaded to
 *   {@link processImage} unchanged.
 * @param file   the encoded input. `format` is `gif` for the v2 animated path.
 * @param options the same options {@link processImage} consumes (mode, target,
 *   output format, EXIF, content-type override).
 * @param onModelProgress optional AI model-download progress callback, forwarded
 *   to {@link processImage} so the UI's first-use indicator still fires under AI
 *   mode for the first frame.
 */
export async function processAnimated(
  deps: PipelineDeps,
  file: { buffer: ArrayBuffer; format: ImageFormat },
  options: ProcessImageOptions,
  onModelProgress?: ModelLoadProgressCb,
): Promise<ProcessImageResult> {
  // First-frame fallback: process the GIF as a still, exactly as v1 did. The
  // browser's createImageBitmap yields the first frame; the rest of the frames
  // are discarded. The UI has already told the user this is a "still for now"
  // path, so this is an honest degradation, not a silent freeze.
  //
  // #18 replaces this body with: decode every frame via gifuct-js → upscale each
  // via the injected upscaler (faithful: every frame; AI: first frame only, per
  // ADR-0006) → re-encode via gifenc. The function signature above stays.
  return processImage(deps, file, options, onModelProgress);
}

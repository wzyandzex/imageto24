# PRD: Format Extension v2 (HEIC input + GIF per-frame)

> Status: Draft (issue publication pending — will be created as a GitHub issue with the `ready-for-agent` label).
> Source: synthesized from the v2 `/grill-with-docs` session. Domain terms follow `CONTEXT.md`; architectural decisions recorded in `docs/adr/0001`–`0006`.

## Problem Statement

v1 (MVP) shipped "support for multiple image formats" but with two gaps users hit immediately:

1. **iPhone users can't upload their photos.** iOS defaults to HEIC for the camera. A user who opens imageto24 on their phone and selects a photo gets a "unsupported file type" rejection. They have to manually convert to JPEG elsewhere first — a step most won't bother with, and a silent loss of a large user segment. HEIC was explicitly deferred to v2 in issue #10.

2. **Animated GIFs lose their motion.** v1 takes only the first frame of a GIF and processes it as a still. A user uploading a 30-frame animated GIF gets back a single upscaled frame — the animation is destroyed. This contradicts the implicit promise of "upload an image, get it upscaled": for a GIF, "the image" is the animation, not one frame.

These are both failures of the format matrix to honour what users actually bring. The fixes are independent but share a theme: the decoder (and the orchestration layer) must treat some formats as richer than "a single frame of pixels".

## Solution

Two independent format extensions, each behind the existing pipeline seam:

### HEIC input (decode-side)

- HEIC becomes a supported **input** format. heic2any (a pure JS/WASM library) is loaded lazily — only when a user uploads a `.heic`/`.heif` file — and run in a Web Worker so the main thread stays responsive during the (multi-second, large-file) conversion.
- The conversion is hidden entirely inside the decoder: `decode(buffer, "heic")` internally converts HEIC → PNG bytes, then decodes the PNG into `ImageData` as usual. The pipeline, the orchestrator, and `runBatch` are unaware HEIC exists — the deep decoder module absorbs the format's complexity.
- HEIC is **input-only**. The output matrix stays PNG / WebP / JPEG; there is no reliable browser-side HEIC encoder, and users don't expect HEIC output anyway. When the source is HEIC, the output format selector recommends PNG (lossless, matching the "preserve native quality" promise).

### GIF per-frame enhancement (decode + orchestration + encode)

- An animated GIF is processed as a sequence of frames, each upscaled independently, and re-encoded into a new animated GIF.
- A new orchestrator, `processAnimated`, owns the frame loop. It is a sibling of `processImage`, not a branch inside it — the two have distinct shapes (one frame vs. a frame sequence + progress + re-assembly), and conflating them would re-introduce the mode-dispatch shallowness the architecture review just removed.
- `processAnimated` reuses the existing `faithfulUpscaler` adapter for each frame (the seam doesn't change; only the loop around it is new). Frames are processed strictly serially and released between frames, exactly like the batch queue's memory discipline (ADR-0001).
- **Faithful mode processes every frame** (Lanczos per frame is millisecond-scale; a 100-frame GIF finishes in seconds). **AI mode enhances only the first frame** — AI-per-frame is unusably slow in a browser-only architecture (ADR-0006). The remaining frames are interpolated by faithful when the GIF is re-assembled, so the output is still a full-length animated GIF. This is surfaced honestly in the UI, not silently applied.
- GIF decode (frame extraction with disposal/offset/transparent-colour handling) uses gifuct-js; re-encoding uses gifenc. Both are small (~50KB total), mature libraries.

### Detection and routing (UI)

- The UI detects whether an uploaded GIF is animated (multi-frame) by reading the GIF header — a millisecond operation at upload time. Animated GIFs route to `processAnimated`; single-frame GIFs and all other formats route to `processImage`.
- The UI shows an honest notice when an animated GIF is loaded under AI mode: "AI enhances the first frame; faithful handles the rest (full-frame AI is too slow in the browser)."

## User Stories

### HEIC input

1. As an iPhone user, I want to upload a HEIC photo directly, so that I don't have to convert it to JPEG first.
2. As a user, I want the HEIC conversion to happen without freezing the page, so that I can still see progress and the UI stays responsive.
3. As a user, I want a loading indicator during HEIC conversion, so that I understand the wait for a large file.
4. As a photographer, I want my HEIC photo's EXIF metadata preserved after upscaling, so that the provenance stays intact.
5. As a user who uploaded HEIC, I want the output format selector to recommend PNG, so that I keep the lossless quality my original implied.
6. As a user in a batch, I want HEIC files mixed with JPEGs to both process, so that one format's presence doesn't break the batch.

### GIF per-frame (faithful)

7. As a user, I want my animated GIF upscaled frame-by-frame, so that the output is still animated at the target resolution.
8. As a user, I want faithful mode to process every frame of my GIF, so that the whole animation is enlarged, not just one frame.
9. As a user, I want per-frame progress during GIF processing, so that I can tell how far along the animation is.
10. As a user, I want the upscaled GIF's timing (frame delays) preserved, so that the animation plays at the same speed.
11. As a user, I want transparency in my GIF preserved across frames, so that transparent regions stay transparent after upscaling.
12. As a user, I want the output GIF to respect the 256-colour limit gracefully, so that it's a valid GIF that plays everywhere.

### GIF per-frame (AI)

13. As a user who picks AI mode on an animated GIF, I want the first frame enhanced, so that at least the key frame benefits from AI.
14. As a user, I want an honest explanation of why only the first frame is AI-enhanced, so that I'm not confused by the result.
15. As a user, I want the remaining frames still upscaled (by faithful), so that the output is a full-length animation, not a single still.

### Detection and routing

16. As a user, I want animated GIFs detected automatically, so that I don't have to declare "this is an animation".
17. As a user uploading a single-frame GIF, I want it treated like a normal image, so that it doesn't go through the animation path needlessly.

### Privacy and trust (continuity)

18. As a user with sensitive HEIC photos, I want the conversion to stay in my browser, so that no image bytes are uploaded (the architecture is unchanged).
19. As a technically-inclined user, I want to verify that the new libraries (heic2any, gifuct-js, gifenc) also run locally, so that the privacy claim still holds for v2.

## Implementation Decisions

> No file paths or code snippets. Hard-to-reverse decisions are in `docs/adr/`; this section references them.

### HEIC decode (ADR-0001 — browser-only, unchanged)

- **Library:** heic2any, loaded lazily (dynamic `import()`) only when a HEIC file is uploaded. Not in the initial bundle — first HEIC upload pays a one-time ~500KB fetch, cached by the browser for return visits.
- **Worker:** heic2any runs in a Web Worker (the existing `processWorker` or a dedicated conversion worker) so the main thread stays responsive. The conversion produces a PNG `ArrayBuffer`; the existing decode path then turns that into `ImageData`.
- **Seam:** the conversion lives inside the decoder. `DecoderDeps.decode(buffer, "heic")` is the only new surface; `processImage`, `runBatch`, and the UI are unmodified. The `ImageFormat` type gains `"heic"`; the format-from-file helper recognises `.heic`/`.heif` and the `image/heic`/`image/heif` MIME types.
- **Output:** HEIC is input-only. The output format matrix is unchanged; the UI recommends PNG when the source is HEIC, matching the lossless promise.

### GIF per-frame (ADR-0001, ADR-0006)

- **Decode:** gifuct-js parses the GIF into frames — each frame is a patch with a disposal method, a position offset, and a delay. The decoder applies disposal/overlay to reconstruct each frame's full-canvas `ImageData`, preserving transparency.
- **Encode:** gifenc re-assembles the upscaled frames into a new animated GIF, preserving per-frame delays and transparent colour. A colour-quantization step (per-frame, or a shared palette) reduces the true-colour upscaled frames to GIF's 256-colour ceiling.
- **Orchestrator:** a new `processAnimated` function, a sibling of `processImage`. It owns: frame extraction → per-frame upscale (serial, memory released between frames) → re-encode → progress callback. It reuses the existing `faithfulUpscaler` adapter for each frame; it does **not** branch inside `processImage`.
- **AI on GIFs:** per ADR-0006, AI mode enhances only the first frame of an animated GIF. `processAnimated` runs AI on frame 0, faithful on the remaining frames, and re-assembles. The decision is in the orchestrator (where mode is already known), not in the adapter.

### Detection and routing

- At upload, the UI reads the GIF header to count frames (gifuct-js's parse is millisecond-scale). The result (`isAnimated`, `frameCount`) feeds `useRunReadiness` (or a sibling) so the UI can route to `processAnimated` vs. `processImage` and show the AI-first-frame notice.
- Single-frame GIFs and non-GIF formats route to `processImage` unchanged.

### What does NOT change

- The pipeline seam (`processImage`, `PipelineDeps`, the two upscaler adapters from the architecture review) is untouched. HEIC and GIF are new inputs/outputs that flow through the existing seam.
- The browser-only architecture (ADR-0001), graceful degradation (ADR-0002), dual AI models (ADR-0003), Cloudflare deployment (ADR-0004), and MIT licensing (ADR-0005) all hold for v2.
- The output format matrix (PNG / WebP / JPEG) is unchanged. No HEIC output, no new output container for GIF (it stays GIF).

## Testing Decisions

> Principle unchanged from v1: test external behavior through the highest deterministic seam; one cohesive seam.

### HEIC

- The decoder seam (`decode(buffer, "heic")`) is the test surface. A Vitest test injects a stub heic2any (or a pre-converted fixture) and asserts that `decode` returns correct `ImageData` for a HEIC input. The real heic2any is exercised end-to-end by a Playwright test with a small HEIC fixture.
- The "HEIC routes through decode transparently" property is asserted by a `processImage` test: pass a HEIC fixture (stubbed conversion) and assert the rest of the pipeline runs unchanged.

### GIF per-frame

- `processAnimated` is tested through its interface (Vitest, Node, stubbed adapters). Tests assert: the number of upscale calls equals the frame count; each frame is released before the next (no accumulation); the re-encoded output carries the expected frame count and delays; AI mode calls the AI adapter exactly once (frame 0) and the faithful adapter for the rest.
- Frame extraction correctness (disposal, offset, transparency) is tested with a small synthetic GIF fixture whose frames are known.
- A Playwright test covers the end-to-end faithful path: upload a small animated GIF → process → download → assert the result is a GIF with the expected frame count and dimensions.

### Detection

- The "is this GIF animated?" detection is a pure function of the file bytes; tested in Vitest with single-frame and multi-frame GIF fixtures.

### What is NOT tested (unchanged from v1)

- AI enhancement pixel quality (non-deterministic, no WebGPU in CI).
- Real heic2any performance (exercised only in Playwright, not asserted on timing).

## Out of Scope

- **Animated WebP / APNG per-frame.** v2 covers GIF only; other animated containers degrade to first-frame (as in v1). Animated WebP/APNG is a v3 candidate.
- **HEIC output.** No reliable browser-side HEIC encoder exists; output stays PNG/WebP/JPEG.
- **AI per-frame for GIFs.** Deliberately excluded (ADR-0006) — unusably slow in-browser. Revisit only with a server GPU or a much faster in-browser model.
- **MP4 / video processing.** Video is a different problem domain (WebCodecs, audio, seeking) and is not part of "image upscaling".
- **HEIC sequence (burst photos).** HEIC can contain multiple images (iPhone bursts); v2 treats HEIC as a single still. Multi-image HEIC is a v3 candidate.
- **GIF colour-depth increase.** GIF's 256-colour limit is inherent; v2 quantizes upscaled frames back to 256 colours. "Deep-colour GIF" is not a real format.

## Further Notes

- **Privacy claim holds.** heic2any, gifuct-js, and gifenc all run in the browser (in Workers). No image bytes leave the device. The open-source license extends to cover these dependencies' licenses (heic2any is MIT; gifuct-js and gifenc are MIT-compatible).
- **Bundle weight.** heic2any (~500KB) is lazy-loaded only on HEIC upload; gifuct-js + gifenc (~50KB total) are small enough to bundle or lazy-load on first GIF. First-load weight for non-HEIC/non-GIF users is unchanged from v1.
- **GIF colour quantization is a visible quality step.** A faithful-upscaled frame has true colour; reducing to 256 colours for GIF introduces banding. This is inherent to GIF and is stated honestly, not hidden. The UI can note "GIF output is limited to 256 colours per frame".
- **`processAnimated` and the batch queue.** An animated GIF is a single file that expands internally to many frames; it is not the same as a batch of separate files. `processAnimated` owns its own serial frame loop and is not routed through `runBatch`. A batch may contain a mix of stills and animated GIFs; the batch queue calls `processImage` for stills and `processAnimated` for animated GIFs, per-item.

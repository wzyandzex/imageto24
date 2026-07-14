# Image Upscaling

A browser-based tool that upscales images to high resolution (up to 4K) while preserving native image quality. Local processing is the default; optional cloud temporal enhancement is upload-gated and limited to animated AI runs.

## Language

### Processing modes

**Upscale**:
The act of increasing an image's resolution to a higher pixel count. The umbrella term covering both enhancement and faithful interpolation.
_Avoid_: Enlarge, zoom, magnify, resize

**Enhance (AI mode)**:
Reconstructing an image at a higher resolution using an AI model that generates new detail not present in the original. Not lossless — the output pixels are model-generated.
_Avoid_: Super-res, upscale (ambiguous), sharpen

**Interpolate (faithful mode)**:
Increasing resolution by computing new pixels through a deterministic mathematical algorithm (Lanczos) applied to the original pixels. Lossless in the mathematical sense — no information is invented.
_Avoid_: Resize, scale, bicubic (specific algorithm, not the mode)

**Faithful mode**:
The processing mode that uses interpolation. Guarantees mathematically lossless upscaling, output as PNG or lossless WebP, with EXIF preserved. The honest "native quality" promise.
_Avoid_: Lossless mode (ambiguous), basic mode, simple mode

**AI mode**:
The processing mode that uses an AI model to enhance detail. Produces visually sharper results but is non-lossless — the model reconstructs detail that may differ from the true original.
_Avoid_: Pro mode, smart mode, HD mode

### Resolution control

**Target resolution tier**:
A named resolution goal presented to users (1080p / 2K / 4K). The system reverses this into an upscale factor by aligning to the nearest model-supported integer multiple, then Lanczos-adjusts to the exact target.
_Avoid_: Output size, final resolution

**Upscale factor**:
The integer multiple (2x / 3x / 4x) by which the model or interpolation algorithm natively operates. Exposed as an advanced control; the default path routes through target tiers.
_Avoid_: Scale, zoom level, multiplier

### Content detection

**Content type**:
The category of an image that determines which AI model suits it best — photo or anime/illustration. Detected automatically; manually overridable.
_Avoid_: Image type (conflicts with format), style, category

**Photo content**:
Real-world photographs with continuous tones and natural noise. Handled by the Real-ESRGAN general model.
_Avoid_: Realistic image, normal image

**Anime/illustration content**:
Drawn images with flat colors, hard edges, and clean lines. Handled by the Real-ESRGAN anime model, which avoids the artifacts the general model produces on this content.
_Avoid_: Cartoon, drawing, 2D image

**Model routing**:
The decision that selects the AI model expected to produce the best result for a source. Routing is automatic by default, based on content type, input format, and whether the source is animated; expert users may override it manually. v5 prioritizes animation/video-friendly models for cloud temporal enhancement before broadening the still-image model catalogue.
_Avoid_: Model selection (ambiguous about user vs system), model mode, AI type

### Delivery and limits

**Device capability check**:
The runtime detection of whether the user's browser and hardware support WebGPU and have sufficient memory to run AI mode. On failure, AI mode is disabled and faithful mode becomes the available path.
_Avoid_: Feature detection (too generic), compatibility check

**Batch queue**:
The serial processing pipeline for multiple images — each image is decoded, processed, encoded, and released from memory before the next begins, preventing out-of-memory failures.
_Avoid_: Batch processing (ambiguous about parallelism), queue (too generic)

### Run readiness

**Run readiness**:
The full set of run-orchestration decisions derived (purely) from the probed device capability, the loaded source, and the user's options: which mode would actually run, whether AI is available and why, the resolved target, the computed factor, whether the trigger is disabled, and the effective output. Computed in one pass by `resolveRunReadiness`; the thin `useRunReadiness` hook owns only the capability-probe side effect.
_Avoid_: Run config, run state (conflicts with runtime state like status/result), readiness check (too narrow)

**Effective mode**:
The mode a run would actually target — the user's selection, downgraded to faithful when AI is unavailable. A derived value, never a mutation of the user's selection. The user's `mode` is preserved; `effectiveMode` is what the UI displays as the active run target and what the run consumes.
_Avoid_: Actual mode, forced mode, resolved mode (ambiguous with the user's choice)

### Animated images

**Animated image**:
An image file that contains a sequence of frames played in sequence to produce motion. Per-frame processing covers animated GIF (v2) and animated WebP (v3); v4 adds APNG as both an input and output container, so all three animated formats are processed frame-by-frame.
_Avoid_: Video, animation (too generic), movie

**Frame**:
A single still image within an animated image, with its own pixels, delay, and disposal method. A GIF is a sequence of frames; processing an animated image means processing each frame and reassembling them.
_Avoid_: Image (collides with the whole file), picture, layer

**Per-frame enhancement**:
Processing every frame of an animated image through the pipeline independently, then re-encoding the results into a new animated container. Offered for faithful mode; deliberately not offered for AI mode in v2 (too slow in-browser).
_Avoid_: Full enhancement, complete enhancement

**First-frame-only**:
The fallback path for animated images in AI mode: only the first frame is enhanced; the remaining frames are carried through unchanged. Surfaced to the user with an honest explanation rather than silently applied.
_Avoid_: Partial enhancement, single-frame (ambiguous with still images)

### Animated output (v3)

**Animated output format**:
The container a processed animated image is written to. For local browser processing, it is determined by device capability: APNG when WebCodecs is available (true-colour, transparency), GIF when it is not (256-colour, universal fallback). APNG inputs are always output as APNG. For cloud temporal enhancement, APNG is the default quality-preserving output, with GIF available only as an explicit compatibility export.
_Avoid_: Output container, animated export

**Animated codec**:
The format-agnostic seam behind animated encode/decode. `decodeAnimated(buffer, format)` returns per-frame `ImageData` regardless of whether the source is GIF or WebP; `encodeAnimated(frames, dims)` produces an animated container. Each format's specifics (256-colour quantization for GIF, WebCodecs decode for WebP) live inside the adapter implementations, not in the orchestration.
_Avoid_: GIF codec, WebP codec (format-specific; use these only when naming a specific adapter)

**Colour fidelity**:
Whether the animated output preserves the source's full colour depth. APNG output is true-colour (full fidelity); GIF output is quantized to 256 colours per frame (reduced fidelity, an inherent GIF limit). The WebCodecs-or-degrade decision exists to maximize colour fidelity where the device allows it.
_Avoid_: Colour quality, colour accuracy, high colour

### Enhancement control (v4)

**Enhancement strength**:
A user-facing scalar (0–100%) controlling how aggressively the AI model's output replaces the original in AI mode. Implemented locally as an alpha-blend ratio, not a model parameter: at 0% the output equals faithful Lanczos, at 100% it equals pure AI reconstruction, and in between the two are linearly blended per pixel. Available for still images in AI mode and for cloud temporal enhancement with one uniform strength across the whole animation. Hidden for local animated AI inputs, where blending an AI-enhanced first frame against faithful subsequent frames causes visible frame-to-frame inconsistency.
_Avoid_: AI level, model intensity, sharpen amount

**Alpha blend**:
The pixel operation behind enhancement strength: `out = α × aiUpscaled + (1 − α) × lanczosUpscaled`. A deterministic, per-pixel linear interpolation between the AI-enhanced output and the faithful upscaled output at the same resolution. Owned by the blending upscaler, which runs both upscalers and combines their results.
_Avoid_: Mix, interpolation ratio, opacity

**Blending upscaler**:
The deep module that implements alpha blend behind a single seam. It runs the AI upscaler and the faithful upscaler on the same source, then blends their outputs at the given alpha. Invoked only when enhancement strength is below 100% (α < 1); at 100% the orchestrator calls the AI upscaler directly, skipping the redundant faithful pass.
_Avoid_: Hybrid upscaler, mixed upscaler, dual upscaler

**Enhancement preset**:
A named shortcut for a specific enhancement strength value. Presets do not replace the 0–100% slider; selecting one moves the slider to its preset value, and the user can still fine-tune afterward. The v5 preset set is Natural 35%, Balanced 60%, Crisp 80%, and Full AI 100%.
_Avoid_: Strength mode, AI preset (ambiguous with model preset), filter preset

### Hybrid processing (v5)

**Hybrid opt-in**:
A processing boundary where local processing remains the default and privacy-preserving path, while a specific high-compute feature may send image bytes off-device only after the user explicitly chooses it. The user's ordinary still-image and faithful workflows remain local; cloud work is not an automatic fallback.
_Avoid_: Cloud mode (too broad), server mode, hybrid upscaler (conflicts with blending upscaler)

**Cloud temporal enhancement**:
Enhancing an animated image through remote GPU processing with temporal awareness, so the output is AI-reconstructed consistently across frames rather than treating each frame as an unrelated still image. Used to avoid both first-frame-only inconsistency and per-frame AI flicker when the user wants the highest animated AI quality. It is an all-frames operation: animations that exceed product limits are rejected or routed back to local options rather than partially enhanced. The source uploaded for this path is the original animated file, not a browser-expanded frame sequence.
_Avoid_: Cloud frame enhancement, server-side AI (too broad), AI animation (ambiguous), full enhancement (ambiguous)

**Temporal frame sequence**:
The server-side representation used for cloud temporal enhancement: decoded animation frames in playback order plus timing, transparency, disposal, and blend metadata. It is not a lossy video transcode; it exists so video/temporal models can process neighbouring frames while the service can rebuild an animated image afterward. When the temporal model only supports RGB, alpha is reconstructed separately with faithful interpolation or edge-aware preservation, then recombined with the enhanced RGB output.
_Avoid_: Video conversion, frame upload, sprite sheet

**Upload consent**:
The explicit user action that authorizes source image bytes to leave the device for cloud temporal enhancement. It is required before any remote processing starts and is separate from selecting AI mode.
_Avoid_: Permission (too generic), cloud enabled, accepted terms

**Cloud retention window**:
The short, automatic deletion period for uploaded source files and generated cloud results. It exists only so long-running jobs can complete and users can recover downloads after refresh or transient network failures; users can request immediate deletion.
_Avoid_: Storage, history, backup

**Cloud job**:
An asynchronous cloud temporal enhancement run. It has visible stages such as uploading, queued, processing, encoding, ready, failed, expired, and deleted, and can be resumed through a recovery link during the cloud retention window.
_Avoid_: Request, task (too generic), session

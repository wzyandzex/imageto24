# Image Upscaling

A browser-based tool that upscales images to high resolution (up to 4K) while preserving native image quality, with no server-side processing.

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

### Delivery and limits

**Device capability check**:
The runtime detection of whether the user's browser and hardware support WebGPU and have sufficient memory to run AI mode. On failure, AI mode is disabled and faithful mode becomes the available path.
_Avoid_: Feature detection (too generic), compatibility check

**Batch queue**:
The serial processing pipeline for multiple images — each image is decoded, processed, encoded, and released from memory before the next begins, preventing out-of-memory failures.
_Avoid_: Batch processing (ambiguous about parallelism), queue (too generic)

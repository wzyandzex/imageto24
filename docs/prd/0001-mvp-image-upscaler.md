# PRD: Image Upscaler MVP

> Status: Draft (issue publication pending — `gh` CLI not yet installed; will be created as a GitHub issue with the `ready-for-agent` label once available).
> Source: synthesized from the `/grill-with-docs` session. Domain terms follow `CONTEXT.md`; architectural decisions recorded in `docs/adr/0001`–`0005`.

## Problem Statement

People have images — old photos, web downloads, illustrations, product shots — that look soft or pixelated when viewed on modern high-resolution screens or printed at a larger size. They want these images to be sharper and larger (up to 4K) without the result looking obviously "processed."

Two distinct needs sit inside this single problem, and today's tools rarely serve both well:

1. **"Make it sharper"** — the user is fine with the tool inventing plausible detail to make the image look crisp. This is enhancement.
2. **"Make it bigger, but don't touch the pixels"** — the user (a photographer, an archivist, someone treating an image as evidence) needs the output to be a mathematically faithful enlargement of the original. Any invented detail would be unacceptable. This is faithful interpolation.

Existing tools tend to offer one or the other. The ones that do both usually require an upload to a server, which is a non-starter for users who care about privacy (medical, legal, personal photos). Free, browser-based options are scarce and typically only do basic resizing.

## Solution

A free, open-source, browser-based image upscaler that offers both modes in one place and never uploads a single pixel to a server.

- **Faithful mode** — mathematically lossless Lanczos interpolation. Output as PNG or lossless WebP with EXIF preserved. This is the honest "native quality" promise: provable, deterministic, zero information loss.
- **AI mode** — Real-ESRGAN enhancement that reconstructs detail for a visibly sharper result. Honest about being non-lossless, with the model (general for photos, anime for illustrations) chosen automatically by an in-browser content classifier.
- **Privacy by architecture** — all processing runs in the user's browser via WebGPU and WebAssembly. No image bytes leave the device. This is the core trust hook, not a marketing afterthought.
- **Universal fallback** — on devices that can't run AI mode (no WebGPU, insufficient memory), the tool gracefully degrades to faithful mode rather than erroring out. Everyone gets a usable result.
- **Batch support** — multiple images processed serially in a queue, each released from memory before the next begins, so large batches don't crash the browser.

The user controls the output by choosing a target resolution tier (1080p / 2K / 4K), with an advanced path to select an explicit upscale factor or custom pixel dimensions.

## User Stories

### Core interaction

1. As a visitor, I want to upload an image by drag-and-drop or file picker, so that I can start upscaling without reading instructions.
2. As a user, I want to see a preview of my uploaded image with its current dimensions, so that I know what I'm working with.
3. As a user, I want to choose between Faithful mode and AI mode, so that I can pick the right trade-off for my image.
4. As a user, I want to select a target resolution tier (1080p / 2K / 4K), so that I get output at the size I actually want.
5. As a user, I want to trigger the upscale and see a progress indicator, so that I know the tool is working and roughly how long it will take.
6. As a user, I want to download the result in my chosen format, so that I can use it.

### Faithful mode

7. As a photographer, I want faithful mode to produce mathematically lossless output, so that I can enlarge an image without altering a single pixel's information.
8. As a photographer, I want faithful mode to output PNG or lossless WebP, so that no compression artifacts are introduced.
9. As an archivist, I want EXIF metadata (camera, lens, settings, GPS) preserved in faithful mode, so that the image's provenance stays intact.
10. As a privacy-conscious user, I want a button to strip EXIF metadata before download, so that I control what metadata leaves with the image.
11. As a user, I want faithful mode to run on any device, so that I can always fall back to it when AI mode is unavailable.

### AI mode

12. As a casual user, I want AI mode to make my blurry image look sharper, so that it looks good on a high-resolution screen.
13. As a user, I want the tool to automatically detect whether my image is a photo or anime/illustration, so that I don't have to know which model to pick.
14. As an advanced user, I want to manually override the content type detection, so that I can correct a misclassification.
15. As a photographer, I want the UI to clearly state that AI mode is non-lossless and reconstructs detail, so that I'm not misled into thinking it's a faithful enlargement.
16. As an anime/illustration creator, I want AI mode to use the anime model on my images, so that lines stay clean instead of getting the artifacts the general model produces.
17. As a first-time AI mode user, I want a loading indicator while the model downloads, so that I understand why there's a wait and don't think the tool is broken.

### Resolution control

18. As a user, I want to pick a named resolution tier (1080p / 2K / 4K), so that I can express my goal in the terms I actually think in.
19. As an advanced user, I want to switch to an explicit upscale factor (2x / 3x / 4x), so that I can control the operation directly.
20. As a user with a specific requirement, I want to enter custom output dimensions, so that I can hit an exact target size.
21. As a user, if my requested target is smaller than the original, I want the tool to tell me rather than silently doing nothing useful, so that I understand the boundary.
22. As a user, if my requested target would exceed my device's memory, I want the tool to warn and offer a safe alternative, so that I don't crash my browser.

### Batch processing

23. As a professional, I want to select multiple images at once, so that I can process a batch without one-by-one tedium.
24. As a user processing a batch, I want each image handled one at a time with memory released between them, so that a large batch doesn't crash my browser.
25. As a batch user, I want an overall progress indicator plus per-image status, so that I can tell how far along the batch is.
26. As a batch user, I want to download all results, so that I get my processed images without downloading them individually.
27. As a batch user, if one image fails, I want the batch to continue with the others, so that one bad file doesn't waste the whole run.

### Device capability and degradation

28. As a user on an older device, if my browser can't run WebGPU, I want the AI option visibly disabled with an explanation, so that I understand why rather than hitting a cryptic error.
29. As a user on a low-memory device, if AI mode would exceed my memory budget, I want the tool to detect this and offer faithful mode, so that I still get a result.
30. As a user, I want faithful mode to always be available regardless of device capability, so that the tool is never completely unusable.

### Formats

31. As a user, I want to upload JPEG, PNG, and WebP images, so that I can use the common formats my images come in.
32. As a user, I want to upload AVIF images, so that I can use this increasingly common modern format.
33. As a user, I want to upload a GIF and have its first frame processed, so that I can upscale a still from it.
34. As a user, I want to choose my output format, so that I can match the result to where it'll be used.
35. As an iOS user, I understand HEIC is not supported in v1 and will convert to JPEG first; I want this stated clearly, so that I'm not surprised.

### Privacy and trust

36. As a user with sensitive images, I want assurance that no image data is uploaded, so that I trust the tool with private photos.
37. As a user, I want to verify the privacy claim, so that I'm not just taking a marketing promise at face value.
38. As a technically-inclined user, I want the source code to be open, so that I can audit the privacy claim myself.

### Distribution

39. As a user, I want to access the tool from any modern browser, so that I don't have to install anything.
40. As a user, I want the tool to load fast, so that I'm not waiting on the initial page.
41. As a user who wants to support the project, I want a donation link, so that I can contribute without a paywall.

## Implementation Decisions

> No file paths or code snippets. Architectural decisions that qualify as "hard to reverse" are recorded in `docs/adr/` and referenced here.

### Architecture (per ADR-0001, ADR-0002)

- **Browser-only.** All decoding, processing, and encoding run client-side. No image bytes are transmitted. This is non-negotiable.
- **No backend.** There is no server, no API, no database. The site is a static bundle deployed to Cloudflare Pages (ADR-0004).
- **Graceful degradation.** A device capability check gates AI mode. When unavailable, AI mode is disabled in the UI and faithful mode is the offered path. The product never hard-errors on an unsupported device.

### The processing pipeline (the central abstraction)

The core of the system is a pure pipeline operating on `ImageData` (the project's in-memory image representation):

- `decode(buffer, format) → ImageData` — turns an encoded file into pixel data. Format support per the formats section below.
- `classify(imageData) → Content type` — a lightweight in-browser classifier returning `photo` or `anime`. Runs in milliseconds; informs model selection.
- `computeUpscaleFactor(srcSize, targetTier or custom) → factor` — resolves a user's resolution goal into the integer upscale factor the model/algorithm will use, aligning to the nearest supported multiple and noting any residual adjustment needed.
- `upscale(imageData, {mode, factor, model}) → ImageData` — the actual enlargement. In faithful mode this is Lanczos interpolation (deterministic, lossless). In AI mode this is ONNX model inference via the selected model.
- `encode(imageData, {format, lossless, preserveExif}) → buffer` — turns pixel data back into a file, with format and metadata options.
- `checkDeviceCapability() → {webgpu: bool, memBudget: number}` — detects WebGPU support and an estimated memory budget for AI work.

These are **injectable seams**: model loaders, Canvas/OffscreenCanvas APIs, and ONNX Runtime are passed in as dependencies so the pipeline functions remain testable in a Node environment without a browser.

An orchestration function `processImage(file, options)` composes the pipeline, threading through the capability check, classification, model loading (lazy), and memory release between batch items.

### AI inference (per ADR-0003)

- **Runtime:** ONNX Runtime Web with WebGPU execution provider. Falls back to WebAssembly where WebGPU is absent but memory is sufficient.
- **Models:** two Real-ESRGAN models in ONNX format — a general model (~65MB) for photo content and an anime model (~18MB) for anime/illustration content.
- **Lazy loading:** the general model loads on first AI-mode use; the anime model loads only when anime/illustration content is detected or the user manually selects it. Model files are served from Cloudflare R2 (ADR-0004), not bundled in the Pages deploy, to keep the repo lean and avoid bundler limits.
- **Caching:** downloaded models are cached in IndexedDB to avoid re-downloading on return visits.

### Faithful interpolation

- **Algorithm:** Lanczos resampling. Deterministic and lossless in the mathematical sense.
- **Output:** PNG or lossless WebP, always. EXIF preserved by default with a user-facing strip option.

### Resolution control

- **Default path:** user selects a target resolution tier (1080p / 2K / 4K). The system computes the needed factor from the source's long edge, aligns to the nearest model-supported integer multiple (2x/3x/4x), runs the upscale, then Lanczos-adjusts to the exact target if the model output differs.
- **Advanced path:** explicit factor selection (2x/3x/4x) or custom pixel dimensions.
- **Boundary rules:** target smaller than source → inform the user, no upscale performed. Target exceeding memory budget → warn and offer a safe alternative (smaller tier or faithful mode).

### Batch processing

- **Serial queue.** The batch queue processes one image fully — decode, process, encode — before starting the next, releasing each image's memory in between. No parallel model runs.
- **Per-item resilience.** A failure in one image is caught and reported; the queue continues with the rest.
- **Progress feedback.** Overall progress plus per-item status during the run.

### Format support (v1)

- **Input:** JPEG, PNG, WebP, AVIF (all browser-native decode), GIF (first frame only).
- **Output:** user-selectable — PNG, WebP (lossless or lossy), JPEG. Faithful mode constrains output to PNG/lossless WebP to honor the lossless promise.
- **Out of scope v1:** HEIC (v2 target), animated images (per-frame enhancement is a separate problem).

### Frontend stack (per ADR-0004, ADR-0005)

- React + Vite + TypeScript. shadcn/ui for components. Web Workers for processing to keep the UI responsive.
- MIT licensed, open-source. Real-ESRGAN model licenses noted separately and respected.

### Deployment (per ADR-0004)

- Static site to Cloudflare Pages; model files to Cloudflare R2 with zero-egress serving.
- Push-to-deploy from the `main` branch.

## Testing Decisions

> Principle: test external behavior, not implementation details. One cohesive seam across the codebase, at the highest level that stays deterministic.

### The single seam: pure pipeline functions (Vitest)

The pipeline functions named above (`decode`, `classify`, `computeUpscaleFactor`, `upscale`, `encode`, `checkDeviceCapability`) and the orchestrator `processImage` are the testing surface. They are written as injectable, environment-agnostic functions so they run under Vitest in Node without a browser, with ONNX Runtime, Canvas, and model loading stubbed or replaced.

- **Faithful-mode upscale is deterministic** — given a source `ImageData` and a factor, Lanczos produces identical pixels every run. These tests assert exact output dimensions and can assert exact pixel output against committed fixtures. This is the project's testing stronghold.
- **Faithful-mode encode asserts the lossless contract** — output is PNG or lossless WebP, EXIF is preserved when requested and stripped when requested.
- **`computeUpscaleFactor` asserts resolution-tier resolution logic** — including the boundary rules (target below source, memory-budget warnings).
- **`classify` asserts content-type routing** — given fixture images of known content type, returns the expected category.
- **AI-mode upscale asserts structure, not pixels** — because model output is non-deterministic across runs and CI lacks WebGPU, AI-mode tests assert only that the pipeline was invoked correctly, the output dimensions match the requested factor, the shape is valid `ImageData`, and no error was thrown. Pixel-level quality is not a CI assertion.

### End-to-end tests (Playwright, minimal)

A small set of Playwright tests covers the user-facing flows that the pure-function seam can't reach:

- Upload → faithful mode → 4K → download: asserts the downloaded file is a valid image at the expected dimensions. Deterministic.
- Device capability mocked to "unsupported": asserts the AI option is disabled and faithful mode is offered.
- Batch upload of multiple images: asserts progress advances and all results download.

End-to-end is intentionally thin — it's slow and AI inference can't be quality-asserted in CI. The pure-function seam carries the weight.

### What is NOT tested

- AI enhancement quality (non-deterministic, no GPU in CI).
- WebGPU-specific behavior beyond capability detection.
- Cross-browser rendering of the UI (Playwright covers the Chromium path).

## Out of Scope

- **Server-side processing of any kind.** No upload pipeline, no server-side GPU, no accounts. (ADR-0001.)
- **Paid tiers, accounts, or usage limits.** The tool is free and open-source. (ADR-0005.)
- **HEIC input support.** Deferred to v2; the decode library footprint is not justified for MVP.
- **Animated image enhancement.** Per-frame AI enhancement of GIFs/animated WebP/video is a separate problem and out of scope.
- **AI mode on unsupported devices.** These devices get faithful mode; we do not build a server fallback. (ADR-0002.)
- **Image editing beyond upscaling.** No cropping, rotation, filters, or color correction. The tool does one thing.
- **Adjustable enhancement strength / model parameters.** v1 exposes mode, resolution, and format only. Tunable sliders are a v2 consideration.
- **Mobile-native apps.** The tool is browser-based; a responsive web UI is the only mobile surface.

## Further Notes

- **Privacy is verifiable, not just claimed.** Because there's no backend, a user (or auditor) can confirm via browser DevTools network panel that no image bytes are transmitted. The open-source license makes the claim auditable in code. This two-layer proof (no network calls + readable source) is the trust strategy.
- **Model licensing must be handled carefully.** Real-ESRGAN is released under its own license; the project must attribute it correctly and not re-license the model weights under MIT. The MIT license applies to the project's own source only.
- **First-load weight is the main UX risk.** The ~65MB general model dominates first-use latency. Mitigations: accurate loading UI, R2/CDN caching, IndexedDB persistence for return visits, and lazy-loading the anime model so most users never download it.
- **The honest framing of AI mode matters.** Calling it "HD" or "lossless enhancement" would mislead. The UI must use the term `Enhance` and state plainly that detail is reconstructed, not recovered — this is both ethical and a legal safeguard against "false lossless" complaints.
- **Issue publication:** this PRD will be created as a GitHub issue (applying the `ready-for-agent` triage label) once the `gh` CLI is installed and authenticated. Until then it lives versioned at `docs/prd/0001-mvp-image-upscaler.md`.

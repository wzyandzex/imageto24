# PRD: Format Expansion (v2) — HEIC input + animated GIF enhancement

> Status: Draft (to be published as a GitHub issue with `ready-for-agent` once issues are split via `/to-issues`).
> Source: synthesized from the v2 `/grill-with-docs` session. Domain terms follow `CONTEXT.md`; architectural decisions recorded in `docs/adr/0001`–`0006`.

## Problem Statement

v1 ships a complete browser-based upscaler, but two format gaps cost real users:

1. **iPhone users cannot upload their photos.** HEIC/HEIF is the default capture format for modern iOS devices — the single largest source of new photos in the world. v1 rejects HEIC and tells users to convert first. That friction loses a large share of mobile users at the door, and many of them never come back. The promise of "drag, drop, done" breaks for anyone whose library is HEIC.

2. **Animated GIFs lose their motion.** v1 extracts only the first frame of a GIF and upscales it as a still. The result is a frozen frame, not the animation the user uploaded. GIFs are the most common animated format on the web; users expect their animated uploads to stay animated.

Both gaps are cases where v1's "support multiple formats" promise under-delivered. v2 closes them, entirely in the browser, preserving the privacy-by-architecture positioning (ADR-0001) that is the product's core trust hook.

## Solution

Two independent feature lines, both delivered browser-only:

**Line 1 — HEIC input.** HEIC files are accepted on upload and decoded via `heic2any`, lazy-loaded into a Web Worker on first HEIC use. The conversion is hidden inside the decoder seam (`decode(buffer, "heic")`), so the rest of the pipeline — `processImage`, the batch queue, the orchestration — is completely unaware HEIC exists. Output is never HEIC (no browser-side HEIC encoder exists; users want PNG/JPEG/WebP anyway).

**Line 2 — Animated GIF enhancement.** Multi-frame GIFs are detected on upload and routed to a new `processAnimated` orchestration, which decodes each frame via `gifuct-js`, processes them, and re-encodes a new GIF via `gifenc`. In faithful mode every frame is enhanced (instant, the real value). In AI mode only the first frame is enhanced (per ADR-0006 — AI-per-frame is unusably slow in-browser); the UI states this honestly rather than silently degrading.

Animated WebP/APNG continue to be treated as stills (first frame only); they remain a v3 target. The user never picks a "mode" for these — detection and routing are automatic, with clear messaging.

## User Stories

### HEIC input

1. As an iPhone user, I want to drag a HEIC photo straight from my library, so that I can upscale it without converting first.
2. As an iPhone user, when I pick a HEIC file, I want it accepted, so that I'm not told my photos are an unsupported type.
3. As a user with mixed-format photos, I want to batch-upload a mix of HEIC, JPEG, and PNG, so that the whole set processes without format errors.
4. As a user, when I upscale a HEIC, I want to download the result as PNG or JPEG, so that I can share or archive it in a universal format.
5. As a first-time HEIC user, I want a loading indicator while the converter loads, so that I understand the one-time wait for the HEIC decoder.
6. As a user with a large HEIC, I want conversion to run off the main thread, so that the UI stays responsive while it works.
7. As a user, if HEIC conversion fails, I want a clear error, so that I can try a different file rather than seeing a generic crash.

### Animated GIF — faithful mode (per-frame)

8. As a user, I want to upload an animated GIF and have it stay animated after upscaling, so that the motion is preserved.
9. As a user, I want faithful mode to enhance every frame of my GIF, so that the whole animation looks sharp, not just one frame.
10. As a user, I want a per-frame progress indicator, so that I can see the GIF advancing frame by frame.
11. As a user, I want the output GIF to play at the original timing, so that the animation feels the same as the input.
12. As a user, I want transparency in my GIF preserved, so that transparent regions stay transparent after upscaling.

### Animated GIF — AI mode (first-frame-only)

13. As a user in AI mode, I want the first frame of my GIF enhanced, so that at least the cover frame benefits from AI.
14. As a user in AI mode, I want the UI to clearly state that only the first frame is AI-enhanced, so that I'm not surprised that the rest looks different.
15. As a user in AI mode, I want the remaining frames still upscaled (faithfully), so that the output is a full-length GIF at the right resolution, not a single frame.

### Animated GIF — detection and routing

16. As a user, I want an animated GIF detected automatically, so that I don't have to tell the tool it's animated.
17. As a user, I want the UI to tell me how many frames were detected, so that I understand what's being processed.
18. As a user, I want a clear message when the mode I chose limits what happens (e.g. AI + GIF → first frame only), so that the behaviour is never a silent surprise.

### Animated formats not covered in v2

19. As an animated-WebP user, I want a clear message that v2 still treats animated WebP as a single frame, so that I'm not surprised by a still output.
20. As a user, I want to know these formats are planned for a future release, so that I'm not left guessing.

## Implementation Decisions

> No file paths or code snippets beyond decision-encoding shapes. Architecture that qualifies as "hard to reverse" is recorded in `docs/adr/`.

### HEIC input (per grilling Q1–Q3)

- **Library:** `heic2any` (~500KB), lazy-loaded into a Web Worker on first HEIC upload. Not bundled into the main chunk; loaded only when needed so non-HEIC users never pay for it.
- **Conversion lives inside the decoder seam.** `decode(buffer, "heic")` internally converts to a PNG bitmap via heic2any, then decodes normally. `processImage`, the batch queue, and the orchestration are unchanged — HEIC is transparent to them.
- **Format enum grows by one:** the `ImageFormat` union adds `"heic"`. The decoder dispatches on it; everywhere else it's just another input format.
- **Output is never HEIC.** The output matrix stays PNG / WebP / JPEG. No HEIC encoder is shipped.
- **Worker-ized.** HEIC conversion is CPU-heavy; it runs in the existing worker pipeline so the main thread never blocks. Progress is forwarded for the UI.

### Animated GIF — orchestration (per grilling Q5–Q6)

- **New orchestration entry point:** `processAnimated`, sibling to `processImage`. It decodes all frames, runs the per-frame upscale via the same injected upscaler seam (`faithfulUpscaler` / `aiUpscaler`), and re-encodes a GIF. `processImage` is untouched — a single-frame still never enters the animated path.
- **Two entry points, one router.** The UI detects multi-frame on upload and picks `processImage` vs `processAnimated`. This routing is UI-level; the pipeline modules don't branch on "is this animated".
- **Faithful: every frame.** Per-frame enhancement is the value for GIFs. The frame loop calls `faithfulUpscaler.upscale(frame)` for each frame, reassembling at the end.
- **AI: first frame only (ADR-0006).** The first frame runs through `aiUpscaler`; subsequent frames run through `faithfulUpscaler`. The output is a full-length GIF. This is a deliberate, documented trade-off, not a silent degradation.

### Animated GIF — codecs (per grilling Q7)

- **Decode:** `gifuct-js` (~30KB). It parses the GIF frame control blocks (GCE) correctly — disposal methods, frame offsets, transparency — which the native `<img>` decoder mangles. Produces one `ImageData` per frame.
- **Encode:** `gifenc` (~20KB). High-performance encoder; the community standard. Reassembles the enhanced frames into a new GIF with original timings.
- **256-colour quantization.** GIF output requires per-frame palettes; the encode path quantizes the 24-bit enhanced frames down to 256 colours. This is an inherent GIF limit, not something v2 can remove.

### UI detection and routing (per grilling Q8)

- **Auto-detect on upload.** A multi-frame check runs for any GIF (cheap — reads the header). The result (`isAnimated`, `frameCount`) is exposed to the UI.
- **Transparent routing.** Animated → `processAnimated`; still → `processImage`. The user never picks.
- **Honest messaging.** When the chosen mode limits GIF behaviour (AI → first-frame-only), the UI states it plainly: "AI enhances the first frame; faithful handles the rest."
- **Out-of-scope formats named.** Animated WebP / APNG show a notice that they're treated as stills in v2, with a note that full support is planned.

### Out of scope for v2

- Animated WebP and APNG per-frame enhancement (v3).
- MP4 / video processing (v3+).
- HEIC output (no viable browser encoder).
- Adjustable GIF playback speed / frame editing (not an upscaler's job).

## Testing Decisions

> Same testing philosophy as v1: test through the module interface, not implementation details. The pipeline's injectable seams (decoder, upscaler, encoder) are the testing surface.

### HEIC

- The decoder seam is the test surface. `decode(buffer, "heic")` is exercised with a fixture HEIC and asserted to return correct `ImageData` — the heic2any call is behind the seam and can be stubbed under Vitest.
- Boundary cases: malformed HEIC, very large HEIC, conversion timeout — assert the decoder surfaces an honest error rather than hanging or crashing.
- Playwright covers an end-to-end upload → upscale → download for a real HEIC fixture.

### Animated GIF

- `processAnimated` is a new orchestration function with injectable deps — testable under Vitest in Node, like `processImage`. Stub the decoder (returns N frames), the upscaler, and the encoder; assert the frame loop runs the right adapter on each frame.
- The faithful path asserts every frame goes through `faithfulUpscaler`.
- The AI path asserts the first frame goes through `aiUpscaler` and the rest through `faithfulUpscaler` (the ADR-0006 contract).
- GIF assembly (gifuct-js decode + gifenc encode) is exercised end-to-end via Playwright with a small real GIF fixture — a round-trip "decode → faithful upscale every frame → encode" producing a valid playable GIF at the expected resolution.
- Frame-timing and transparency preservation are asserted against a crafted fixture where they're deterministic.

### What is NOT tested

- heic2any's own correctness (it's a dependency; trust its tests).
- gifuct-js / gifenc's own correctness (same).
- AI enhancement quality on GIF frames (non-deterministic, no WebGPU in CI).

## Out of Scope

- **Animated WebP and APNG per-frame enhancement.** Detected as stills (first frame) in v2; full animation support is a v3 target.
- **MP4 / video.** Video processing is a different problem class (WebCodecs, audio, seeking) and out of scope.
- **HEIC output.** No browser-side HEIC encoder exists; output stays PNG/WebP/JPEG.
- **GIF editing.** No trimming, speed change, frame deletion, or captioning — the tool upscales, nothing more.
- **Server-side anything.** v2 stays 100% browser-side (ADR-0001).

## Further Notes

- **HEIC is the higher-ROI of the two lines.** It unlocks the entire iOS user base at the front door. If the two lines were to ship separately, HEIC should ship first.
- **GIF's value is faithful mode.** AI-on-GIF is a courtesy (first frame), not the point. The honest UI messaging around ADR-0006 is load-bearing — it's what keeps the partial enhancement from feeling like a bug.
- **Two new dependencies, both small and lazy.** heic2any (~500KB) loads only on HEIC; gifuct-js + gifenc (~50KB) load only when an animated GIF is detected. Non-users of these formats never download them.
- **Issue publication:** this PRD will be split into vertical-slice issues via `/to-issues` and published with `ready-for-agent` labels.

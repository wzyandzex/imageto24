# PRD: Animated WebP (v3) — per-frame enhancement + true-colour APNG output

> Status: Draft (to be split into vertical-slice issues via `/to-issues`, then published with `ready-for-agent`).
> Source: synthesized from the v3 `/grill-with-docs` session. Domain terms follow `CONTEXT.md` ("Animated output" section); architectural decisions in `docs/adr/0001`–`0007`.

## Problem Statement

v2 made animated GIFs stay animated — but it stopped there. The other widespread animated format, **animated WebP**, is still treated as a still (first frame only) in v2, exactly like v1. A user who uploads an animated WebP gets back a single frozen frame. Given WebP's growing adoption (modern cameras, design tools, web exports), this is a real gap, not an edge case.

The deeper problem is **colour fidelity**. v2's animated output is always GIF, which caps each frame at 256 colours. For a GIF input that's an inherent limit of the source format. But for a true-colour animated WebP, quantizing the enhanced frames down to 256 colours on output throws away exactly the quality the upscaler worked to preserve. A user upscales a vivid animated WebP and gets back a posterized GIF — the enhancement is visually undone by the output format. This is the gap v3 closes.

## Solution

Two coupled changes, both browser-only, both extending v2's `processAnimated` orchestration:

**1. Animated WebP input.** WebP multi-frame files are detected on upload (like GIF was in v2) and routed to `processAnimated`. Frames are decoded via the WebCodecs `ImageDecoder` API where available, falling back to a wasm decoder on browsers without WebCodecs. The decode is hidden behind the same format-agnostic animated-codec seam as GIF.

**2. True-colour APNG output.** When the device supports WebCodecs, the enhanced frames are re-encoded as **APNG** (animated PNG) via UPNG.js — full true-colour, transparency preserved. APNG plays natively in every modern browser and loses no colour depth. When WebCodecs is unavailable, output falls back to GIF (256-colour) — the universal path, never a hard error (ADR-0002). The output format is **not user-chosen** for animated inputs; it is determined by device capability and stated honestly in the UI.

The codec seam is generalized: `decodeAnimated` / `encodeAnimated` replace the GIF-specific `decodeGif` / `encodeGif`. GIF and WebP specifics (256-colour quantization, WebCodecs vs wasm) live inside the adapter implementations; `processAnimated` orchestrates format-agnostically.

APNG is an **output-only** format in v3. APNG inputs are still treated as stills (first frame), like v2 — decoding APNG input is out of scope.

## User Stories

### Animated WebP input

1. As a user, I want to upload an animated WebP and have it stay animated after upscaling, so that the motion is preserved.
2. As a user, I want faithful mode to enhance every frame of my animated WebP, so that the whole animation looks sharp.
3. As a user, I want AI mode to enhance the first frame and faithfully upscale the rest (ADR-0006), so that the cover frame benefits from AI without making the whole run unusably slow.
4. As a user, I want a per-frame progress indicator, so that I can watch the WebP advancing frame by frame.
5. As a user, I want frame timing preserved in the output, so that the animation plays at the original speed.
6. As a user, I want transparency in my WebP preserved through upscaling and output.

### True-colour APNG output

7. As a user on a capable browser, I want my animated WebP upscaled and output as APNG, so that the full colour depth is preserved (no 256-colour posterization).
8. As a user, I want the output to play as an animation in any modern browser, so that I can share it without format issues.
9. As a user, I want transparency in the output, so that transparent regions stay transparent.
10. As a user whose browser lacks WebCodecs, I want the animated output to still be produced (as GIF), so that I never get a hard error — just an honestly-explained quality difference.
11. As a user, I want the UI to tell me *which* animated format I'll get and *why*, so that a GIF-instead-of-APNG result is never a surprise.

### Codec seam and detection

12. As a user, I want the tool to detect WebCodecs capability automatically, so that I don't have to know what WebCodecs is.
13. As a user, I want GIF and WebP handled uniformly, so that the experience is consistent regardless of which animated format I upload.

### Format boundaries (v3 scope)

14. As an APNG-input user, I want a clear message that APNG input is still treated as a still in v3, so that I'm not surprised by a single-frame result.
15. As a user, I want to know APNG input support is planned for a future release, so that I'm not left guessing.

## Implementation Decisions

> No file paths beyond decision-encoding shapes. Architecture qualifying as "hard to reverse" is in `docs/adr/`.

### Generalized animated codec (per grilling Q1)

- The GIF-specific codec methods are generalized: `decodeAnimated(buffer, format)` and `encodeAnimated(frames, dims)` replace `decodeGif` / `encodeGif`. The interfaces are format-agnostic; format dispatch happens inside the adapter.
- `processAnimated` calls the generalized seam. It no longer references GIF, WebP, APNG, or 256-colour quantization by name — those are adapter implementation details.
- Deletion test: removing the generalized codec would scatter format specifics across the orchestrator.

### WebP decode + APNG encode, with GIF degrade (per grilling Q2, Q3)

- **Decode (WebP):** WebCodecs `ImageDecoder` where `typeof ImageDecoder !== 'undefined'`; wasm fallback otherwise. Both produce per-frame `ImageData` behind the seam.
- **Encode (true-colour path):** UPNG.js (~30KB) writes APNG — true-colour, transparency, animated. Lazy-loaded on first animated output that targets APNG.
- **Encode (degrade path):** existing gifenc writes GIF (256-colour, quantized) — unchanged from v2.
- APNG encoding is the colour-fidelity play; GIF encoding is the universal fallback.

### Capability-based codec selection (per grilling Q3, Q6)

- `createBrowserDeps` inspects `typeof ImageDecoder` **on each call** (no global cache) and injects the matching animated-codec pair: WebCodecs-decode + UPNG-encode when available, wasm-decode + gifenc-encode when not.
- `processAnimated` receives a deps bundle already wired for the device; it never branches on capability.
- This concentrates the capability decision in one place (deps assembly), keeping the orchestrator format-and-capability-agnostic.

### UI: read-only animated output format (per grilling Q4)

- For animated inputs, the still-output-format selector becomes read-only and displays the *actual* output: "APNG (true-colour)" or "GIF (256-colour, your browser lacks WebCodecs)".
- The user's still-format selection is irrelevant for animated inputs, as in v2 — but v3 makes the actual output explicit rather than always showing GIF.
- Still-image output format selection is unchanged.

### APNG input is out of scope (per grilling Q5)

- APNG files uploaded as input are still treated as stills (first frame only), exactly as in v2. APNG is an output-only format in v3.
- The UI states this clearly for an APNG input.

### AI on animated WebP (ADR-0006 unchanged)

- AI mode on an animated WebP follows the same ADR-0006 contract as GIF: frame 0 → `aiUpscaler`, frames 1..n → `faithfulUpscaler`. The output is a full-length animated APNG (or GIF on degrade).

## Testing Decisions

> Same philosophy: test through the module interface, deps injected, format specifics behind the seam.

### Generalized codec

- `decodeAnimated` / `encodeAnimated` are the test surface. Under Vitest in Node, the adapters are stubbed; tests assert the orchestrator calls the seam correctly regardless of format.
- GIF-specific tests from v2 are updated to the generalized method names; GIF behaviour is unchanged.

### WebP + APNG path

- The WebCodecs decode + UPNG encode path is exercised end-to-end via Playwright on a Chromium runner (where WebCodecs is available): real animated WebP → faithful upscale → valid playable APNG at the expected resolution, true-colour.
- The degrade path (GIF output) is covered by the existing v2 GIF e2e, which still runs.
- A Playwright test asserts the UI's read-only output-format display for an animated WebP (shows APNG on Chromium).

### What is NOT tested

- UPNG.js's and WebCodecs's own correctness (dependencies; trust their tests).
- AI enhancement quality on WebP frames (non-deterministic, no WebGPU in CI).
- APNG input decoding (out of scope).

## Out of Scope

- **APNG input decoding.** APNG is output-only in v3; inputs are stills (first frame).
- **Animated WebP output.** No mature browser-side WebP animated encoder; APNG is the true-colour output instead.
- **MP4 / video.** Out of scope (same as v2).
- **User-chosen animated output format.** The format is device-determined; no manual APNG/GIF toggle.
- **Server-side anything.** Browser-only (ADR-0001).

## Further Notes

- **Colour fidelity is the point of v3.** v2's animated output was universally GIF; v3's value is preserving true colour where the device allows it. The APNG-vs-GIF split is load-bearing — it's what makes animated WebP worth supporting.
- **WebCodecs is the capability gate, not a feature flag.** There's no user-facing "enable WebCodecs" toggle; detection is automatic and the result is stated honestly in the UI.
- **Two new lazy dependencies.** UPNG.js (~30KB) loads only on APNG output; the WebP wasm fallback (if needed) loads only on WebP input without WebCodecs. Non-animated, non-WebP users never pay for them.
- **The generalized codec is the v3 architecture win.** It unlocks future animated formats (APNG input, AVIF animated) without touching `processAnimated`.
- **Issue publication:** this PRD will be split via `/to-issues` and published with `ready-for-agent` labels.

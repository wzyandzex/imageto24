# PRD: APNG input + Enhancement strength (v4)

> Status: Draft (to be split into vertical-slice issues via `/to-issues`).
> Source: v4 `/grill-with-docs` session. Domain terms follow `CONTEXT.md` ("Enhancement control" + "Animated images" sections); ADRs in `docs/adr/0001`–`0008`.

## Problem Statement

Two gaps remain after v3:

1. **APNG can't be uploaded as an animation.** v3 made APNG an *output* container (true-colour animated output via UPNG.js) but kept APNG *inputs* as stills — the first frame is processed and the rest dropped. A user who has an animated APNG (exported from design tools, screen recorders, or another upscaler) and wants it enlarged gets back a single frozen frame. The format that v3 championed as the true-colour animated output is ironically not accepted as a true-colour animated input.

2. **AI enhancement is all-or-nothing.** A user in AI mode gets the model's full reconstruction — every pixel is AI-generated. There is no way to say "I want *some* AI sharpening but keep it close to the original." Photographers and archivists who find pure AI output too aggressive (over-sharpened, plastic-looking on skin) have no middle ground: they must drop to faithful mode entirely, losing all AI benefit. The binary (faithful vs full-AI) leaves the most interesting region of the spectrum — mild AI assistance — unreachable.

## Solution

Two independent feature lines, both browser-only:

**Line 1 — APNG input.** Animated APNG files are detected on upload (like GIF/WebP before) and routed to `processAnimated`. Frames are decoded via WebCodecs `ImageDecoder` where available (highest fidelity, native speed), falling back to a self-built pngjs-based APNG frame parser on browsers without WebCodecs (robust, full-colour, universal). The decode plugs into the existing generalized `decodeAnimated` seam. Critically, **APNG input always outputs APNG** — since UPNG.js encoding is pure JS and runs on every browser, there is no device-gated degrade to GIF for APNG inputs (unlike WebP, whose *decode* gate triggered the v3 APNG-or-GIF split).

**Line 2 — Enhancement strength slider.** A 0–100% slider in AI mode blends the AI upscaled output with the faithful Lanczos upscaled output: `out = α × ai + (1−α) × lanczos`. At 0% the result equals faithful; at 100% it equals pure AI (current behaviour, zero change). The slider defaults to 100% so existing results are unaffected. It is implemented as a new **blending upscaler** deep module that runs both upscalers and blends — invoked only when α < 1 (at 100% the orchestrator skips the redundant faithful pass). The slider is **hidden for animated inputs**: blending the AI-enhanced first frame against faithful subsequent frames causes visible frame-to-frame inconsistency.

## User Stories

### APNG input

1. As a designer, I want to upload an animated APNG and have it stay animated, so that the motion is preserved through upscaling.
2. As a user, I want faithful mode to enhance every frame of my APNG, so the whole animation looks sharp.
3. As a user, I want AI mode to enhance the first frame (ADR-0006) and faithfully upscale the rest, consistent with GIF/WebP.
4. As a user, I want per-frame progress while my APNG processes.
5. As a user, I want frame timing and transparency preserved in the output.
6. As a user, I want my APNG output to always be APNG (true-colour), not downgraded to GIF — I chose APNG for its colour depth.
7. As a user on a non-WebCodecs browser, I want my APNG to still decode and process (via the fallback parser), not be rejected.

### Enhancement strength

8. As a photographer, I want to dial AI enhancement below 100%, so the result keeps more of the original's natural texture.
9. As a user, I want the slider to default to 100%, so my existing workflow doesn't change unless I touch it.
10. As a user, I want a continuous slider (not discrete steps), so I can fine-tune the exact blend I want.
11. As a user, I want the slider to only appear in AI mode, so it doesn't clutter faithful mode (where it has no meaning).
12. As a user, I want honest labelling: 0% = no AI (equals faithful), 100% = full AI reconstruction.
13. As an animated-image user, I understand the slider is not available for animations (blending the first frame would cause visible inconsistency) — I want this stated clearly, not silently hidden.

## Implementation Decisions

> Architecture qualifying as "hard to reverse" is in `docs/adr/`.

### APNG decode: capability split C+B (per grilling Q1)

- **WebCodecs path:** `ImageDecoder` decodes APNG frames natively where supported — highest fidelity, native speed.
- **Fallback path:** a self-built APNG frame parser on top of pngjs — parses fcTL/fdAT chunks, honours disposal/blend ops, decodes each frame to full-canvas `ImageData`. Universal (pure JS), robust against edge-case APNGs.
- UPNG.js's decode is **not** used for input — its simplified disposal/blend handling is a fidelity risk; the self-built parser handles APNG semantics correctly.
- Both paths plug into the existing `decodeAnimated(buffer, format)` seam; the capability detection from #25 routes to the right one.

### APNG input always outputs APNG (per grilling Q2, ADR-0007 update)

- UPNG.js encoding is pure JS and runs everywhere — APNG output does *not* depend on WebCodecs (unlike WebP, whose *decode* gate drove v3's APNG-or-GIF split).
- Therefore APNG inputs always produce APNG output (true-colour round-trip), never degraded to GIF.
- This is a documented exception to ADR-0007's "output is device-determined" rule — see the ADR-0007 update.
- WebP inputs still follow v3's rule (WebCodecs → APNG, else GIF), because WebP *decode* genuinely gates on WebCodecs.

### Enhancement strength = alpha blend (per grilling Q3, ADR-0008)

- The slider controls a blend ratio α ∈ [0,1]: `out = α × aiUpscaled + (1−α) × lanczosUpscaled`.
- Not a model parameter, not multiple models, not repeated inference, not post-sharpening — see ADR-0008 for the rejected alternatives.
- Default α = 1.0 (100%): existing behaviour unchanged, slider is pure increment.

### Blending upscaler deep module (per grilling Q5)

- New `BlendingUpscalerDeps` seam: `upscale(image, { factor, model, alpha, exactTargetSize })`.
- Internally runs `aiUpscaler.upscale` + `faithfulUpscaler.upscale` on the same source, then blends per-pixel.
- `PipelineDeps` gains a `blendingUpscaler` field.
- `processImage` calls it only when AI mode and α < 1; at α = 1 it calls `aiUpscaler` directly (skips the redundant faithful pass).

### Slider hidden for animated inputs (per grilling Q6)

- Animated inputs (GIF/WebP/APNG) hide the slider. Blending the AI first frame against faithful subsequent frames causes visible frame-to-frame inconsistency — the slider can't be used effectively on animations.
- The UI states this honestly: "Enhancement strength is available for still images only."
- Animated AI first-frame enhancement remains at α = 1 (pure AI), unchanged from v2/v3.

## Testing Decisions

### APNG input

- `decodeAnimated(buffer, "apng")` is the test surface; adapters stubbed under Vitest.
- The self-built parser's chunk parsing (fcTL/fdAT/disposal/blend) is unit-tested directly — it's pure logic over a byte buffer.
- Playwright on Chromium covers the WebCodecs path end-to-end with a real APNG fixture.
- The fallback path is covered by running the same fixture through the parser directly.

### Enhancement strength

- The blending upscaler is a pure function of two stubbed upscaler outputs + α — fully testable in Node.
- Tests assert: α=0 → equals faithful output; α=1 → equals AI output; α=0.5 → exact midpoint per pixel.
- `processImage` tests assert: α=1 calls `aiUpscaler` directly (not blending); α<1 calls `blendingUpscaler`.
- Playwright covers the slider UI: appears in AI+still, hidden in faithful, hidden for animated.

## Out of Scope

- **AI per-frame enhancement for animations.** Still ADR-0006 (browser too slow); the slider doesn't change this.
- **Multiple AI models / model selection.** The slider is a blend ratio, not a model switch.
- **Animated WebP/AVIF output encoding.** APNG remains the true-colour animated output.
- **Server-side anything.** Browser-only (ADR-0001).

## Further Notes

- **APNG input completes the animated-format symmetry.** After v4, GIF, WebP, and APNG are all first-class animated inputs with per-frame processing — the format matrix for animations is closed.
- **The blending upscaler is the v4 architecture win.** It adds controllability without disturbing the existing ai/faithful seam (#3) — it composes them, doesn't fork them.
- **Default 100% is load-bearing.** It guarantees v1–v3 users see zero change; the slider is pure additive capability.

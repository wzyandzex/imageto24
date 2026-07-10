# PRD: Cloud temporal enhancement + presets + model routing (v5)

> Status: Implemented. Split into vertical-slice issues #57–#65 (all delivered): cloud temporal job contract + fake tracer (#57), upload consent + cloud/local routing (#58), async cloud job UI + recovery (#59), retention + deletion (#60), cloud output format APNG/GIF (#61), enhancement presets (#62), model routing + expert override (#63), GPU service MVP (#64), and transparency-preserving enhancement + GIF hardening (#65). The only remaining out-of-scope item is deploying a real GPU service with temporal model weights — a separate deployment effort, not a frontend/service-core slice.
> Source: v5 `/grill-with-docs` session. Domain terms follow `CONTEXT.md` ("Hybrid processing", "Enhancement control", "Content detection", and "Animated images" sections); ADRs in `docs/adr/0001`–`0009`.

## Problem Statement

v4 completed the browser-only animated-format matrix and added enhancement strength for still images, but three high-value gaps remain:

1. **Animated AI quality is still constrained by local hardware.** Local AI mode for animated GIF/WebP/APNG remains first-frame-only because full animated AI in the browser is too slow and memory-heavy. That is honest, but not the best visual result. The best result requires temporal awareness across frames so detail does not flicker or jump from frame to frame.

2. **Enhancement strength is precise but not approachable.** The v4 0–100% slider gives fine control, but users still have to guess good values. Common starting points such as natural, balanced, crisp, and full AI should be one-click presets while preserving the slider for fine tuning.

3. **The model set needs to grow without making users choose model names.** v1's general/anime split works for still images, but v5's cloud temporal enhancement needs animation/video-friendly models. Users should get the best model by default through model routing, with expert override available when needed.

Desktop/Tauri is explicitly out of scope for v5.

## Solution

v5 introduces three coordinated feature lines.

**Line 1 — Cloud temporal enhancement for animated images.** The app remains local-first, but adds a narrow, explicit hybrid path for animations: users may opt in to upload an original animated GIF/WebP/APNG to an independent GPU service. The service decodes the original file, normalizes it into a temporal frame sequence, runs temporal AI enhancement with awareness across neighbouring frames, and re-encodes the result. This is not a silent fallback and not used for still images. The user must give upload consent before source bytes leave the device.

Cloud temporal enhancement is all-frames or not offered. The service may reject inputs that exceed file, frame, pixel, queue, or timeout limits, but it must not silently sample frames, drop frames, or enhance only part of an animation. The default cloud output is APNG for true-colour and transparency preservation. GIF is available only as an explicit compatibility export.

If the temporal model only supports RGB, the service separates RGB from alpha. RGB goes through temporal enhancement; alpha is reconstructed through faithful interpolation or edge-aware preservation, then recombined. Transparent animations must not be flattened onto a background colour.

Cloud runs are asynchronous jobs. The UI shows stages such as uploading, queued, processing, encoding, ready, failed, expired, and deleted. Jobs expose a recovery link during a short cloud retention window. Uploaded source files and generated results are automatically deleted after that window, and users can request immediate deletion.

**Line 2 — Enhancement strength presets.** v5 adds named shortcuts for existing enhancement strength values. Presets do not replace the slider: selecting one moves the slider, and users may fine-tune afterward. The preset set is:

- Natural — 35%
- Balanced — 60%
- Crisp — 80%
- Full AI — 100%

The same strength control applies to still-image AI and cloud temporal enhancement, where one uniform strength applies across the whole animation. It remains hidden for local animated AI, where first-frame-only AI would make strength blending visibly inconsistent.

**Line 3 — Model routing expansion.** v5 expands from the original general/anime model pair toward model routing: automatic model choice by default, expert override when needed. The first new model priority is animation/video-friendly models for cloud temporal enhancement, not a broad still-image model catalogue. Model metadata must describe runtime target, best-fit content, animation suitability, scale factor, availability, and whether the model supports RGB-only or alpha-aware processing.

## User Stories

### Cloud temporal enhancement

1. As an animated-image user, I want an option for highest-quality AI animation enhancement, so every frame is enhanced consistently instead of only the first frame.
2. As a privacy-conscious user, I want local processing to remain the default, so my images do not leave my device unless I explicitly choose upload-based enhancement.
3. As a user, I want a clear upload consent step before cloud processing starts, so I understand that the source file will be sent to a GPU service.
4. As a user, I want the service to process my original animated file, so browser decode differences and client memory limits do not reduce quality.
5. As a user, I want temporal consistency across frames, so AI detail does not flicker or shift during playback.
6. As a user with transparent APNG/WebP assets, I want transparency preserved, so stickers, overlays, and design exports are not flattened onto a background.
7. As a user, I want APNG as the default cloud output, so true colour and transparency are preserved.
8. As a user who needs broad compatibility, I want an explicit GIF export option, so I can trade colour fidelity for compatibility knowingly.
9. As a user, I want progress stages for cloud jobs, so I know whether the upload is queued, processing, encoding, ready, failed, expired, or deleted.
10. As a user, I want a recovery link, so I can refresh the page or recover from a network issue while the job is still retained.
11. As a user, I want uploaded files and results automatically deleted after a short retention window, and I want an immediate delete action.
12. As a user, I want a clear rejection when my animation exceeds limits, not a silently degraded partial result.

### Enhancement presets

13. As a still-image AI user, I want one-click strength presets, so I do not have to guess good slider values.
14. As a cloud temporal enhancement user, I want the same strength presets, so I can choose natural, balanced, crisp, or full AI animation output.
15. As an advanced user, I want the slider to remain available after choosing a preset, so I can fine-tune the exact strength.
16. As a local animated AI user, I understand strength controls are unavailable, because local AI only enhances the first frame.

### Model routing

17. As a casual user, I want the app to choose the best model automatically, so I do not need to understand model names.
18. As an animation user, I want v5 to prioritize animation/video-friendly models, so temporal results are stable rather than just sharper still frames.
19. As an expert user, I want to override model routing, so I can choose a specific model for testing or known content.
20. As a user, I want model availability and limitations surfaced honestly, so I know when a model is local, cloud-only, experimental, RGB-only, or unsuitable for my content.

## Implementation Decisions

> Architecture qualifying as "hard to reverse" is in `docs/adr/`.

### Hybrid opt-in boundary (ADR-0009)

- Local processing remains the default path for still images, faithful mode, and local AI.
- Cloud GPU is allowed only for cloud temporal enhancement of animated images.
- Cloud GPU is not used for still-image AI in v5.
- Cloud processing is never an automatic fallback; it requires upload consent.
- The UI must distinguish local processing from upload-based cloud temporal enhancement before a run starts.

### GPU service architecture

- The existing frontend remains on Cloudflare Pages/R2.
- Heavy inference runs in an independent GPU service.
- Cloudflare Workers may broker jobs, but do not run GPU inference.
- The browser uploads the original animated file, not a browser-expanded frame sequence.
- The service owns decode, temporal enhancement, encode, retention, deletion, limits, and job state.

### Temporal enhancement pipeline

- Decode the original animation into a temporal frame sequence: ordered frames plus timing, transparency, disposal, and blend metadata.
- Run animation/video-friendly temporal AI over the sequence.
- Preserve timing and animation semantics when rebuilding output.
- Do not use a lossy video transcode as the canonical intermediate.
- Do not partially enhance large animations. Reject or route back to local options when limits are exceeded.

### Transparency handling

- Preserve alpha for APNG/WebP/GIF inputs where present.
- If the temporal model is RGB-only, split RGB and alpha.
- Enhance RGB through the temporal model.
- Reconstruct alpha through faithful interpolation or edge-aware preservation.
- Recombine enhanced RGB with reconstructed alpha before encoding output.
- Never flatten transparency onto a background colour as the quality path.

### Cloud output formats

- Default cloud output: APNG, because it preserves true colour and transparency.
- Optional compatibility export: GIF, explicitly labelled as 256-colour and lower-fidelity.
- The local animated output rules from ADR-0007 remain unchanged for local processing.

### Cloud job lifecycle

- Cloud temporal enhancement runs as an asynchronous job.
- Job states include: uploading, queued, processing, encoding, ready, failed, expired, and deleted.
- The UI exposes progress and meaningful failure reasons.
- A recovery link works during the cloud retention window.
- Source files and generated results are automatically deleted after the retention window.
- Users can request immediate deletion before the retention window expires.

### Anonymous limits

- v5 does not require user accounts.
- The service enforces anonymous protection through file size, frame count, pixel count, queue concurrency, rate limits, retry limits, and job timeout.
- Inputs beyond product limits are rejected with a clear explanation and local alternatives.

### Enhancement presets

- Presets are shortcuts over enhancement strength, not a replacement for the slider.
- Preset values: Natural 35%, Balanced 60%, Crisp 80%, Full AI 100%.
- Still-image AI uses the existing v4 local alpha-blend implementation.
- Cloud temporal enhancement applies one uniform strength across the whole animation.
- Local animated AI keeps the slider hidden because local AI is first-frame-only.

### Model routing

- Automatic routing remains the default.
- Expert override is available from an advanced UI.
- v5 prioritizes animation/video-friendly models for cloud temporal enhancement.
- Model metadata must include: model id, display name, runtime target, supported source types, preferred content types, scale factor, alpha support, experimental/stable status, and local/cloud availability.
- The UI should show human-readable model intent, not raw model names as the primary experience.

## Testing Decisions

### Cloud temporal enhancement

- Contract tests cover job creation, upload consent gating, job state transitions, recovery links, deletion, and expiry.
- Service tests cover decode into temporal frame sequence, timing preservation, alpha preservation, APNG encode, and GIF compatibility export.
- Temporal pipeline tests use short fixture animations with known frame counts, timing, transparency, and expected output dimensions.
- Limit tests assert oversized files, too many frames, too many pixels, queue saturation, and timeouts reject clearly without partial enhancement.
- Failure tests assert source/result cleanup on failure, expiry, and immediate deletion.

### Enhancement presets

- UI tests assert preset selection moves the slider to 35/60/80/100.
- Tests assert manual slider movement after selecting a preset still works.
- Still-image tests reuse v4 alpha-blend coverage.
- Cloud job payload tests assert the chosen strength is included once and applies uniformly to the whole animation.
- Local animated AI tests assert strength controls remain hidden.

### Model routing

- Routing tests assert still photo, still anime/illustration, animated photo-like, animated illustration-like, and expert override cases.
- Metadata validation tests assert each model declares runtime target, source suitability, scale factor, availability, alpha support, and stability.
- UI tests assert automatic recommendations are shown in user-friendly language and expert override remains secondary.

## Out of Scope

- Desktop/Tauri application.
- Cloud GPU for still-image AI enhancement.
- Automatic cloud fallback when local AI is unavailable.
- User accounts, paid plans, email notifications, or long-term job history.
- A broad model marketplace or arbitrary user-uploaded models.
- Lossy video transcode as the canonical intermediate for animation processing.
- Silent frame sampling, frame dropping, or partial AI enhancement for oversized animations.

## Further Notes

- v5 intentionally narrows ADR-0001 rather than discarding it: local-first remains the default trust story, with a specific opt-in exception for animation quality that the browser cannot realistically deliver.
- v5 supersedes the local first-frame-only limitation only when the user chooses cloud temporal enhancement. ADR-0006 still governs local animated AI.
- The quality bar is temporal consistency, not merely sharper individual frames.
- The implementation should treat cloud temporal enhancement as a separate deep module/service boundary rather than leaking cloud concerns into the existing local pipeline.

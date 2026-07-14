# Hybrid opt-in cloud GPU for animated temporal enhancement

v5 allows a narrow exception to the original browser-only architecture: animated images may use cloud GPU processing for temporal AI enhancement, but only after explicit user opt-in.

## Context

ADR-0001 made browser-only processing the core privacy promise: image bytes never leave the user's device. That remains the default and the trust baseline for still images, faithful interpolation, and local AI where the user's device can run it.

Animated AI enhancement is different. ADR-0006 deliberately made AI enhancement first-frame-only for animations because running Real-ESRGAN over every frame in-browser is too slow and memory-heavy to be usable. The result is honest, but not the best possible visual outcome: the first frame can be AI-reconstructed while the rest are only faithfully interpolated.

The user goal for v5 is explicitly outcome-first: choose the design that produces the best final image quality rather than the design that minimizes implementation work. For the best animated AI result, the service must process the animation with temporal awareness, not merely treat each frame as an unrelated still image. A remote GPU worker is the only realistic way to do that today without making the browser tab unusable.

## Decision

Local processing remains the default. Cloud processing is allowed only for **cloud temporal enhancement**: AI enhancement of animated images with temporal awareness across frames. It is never an automatic fallback from local failure, and v5 does not use cloud GPU for still-image AI enhancement.

Before any source image bytes leave the device, the user must give **upload consent** through an explicit action. The UI must clearly state that this path sends the image to a remote GPU for processing. If the user does not consent, the app stays on the local paths: faithful per-frame processing or first-frame-only local AI where available.

Cloud temporal enhancement uploads the original animated file to the service. The service owns decode, temporal AI enhancement, and animated re-encode. The browser does not pre-expand the animation into a frame sequence for upload.

Inside the service, the animation is normalized into a temporal frame sequence: decoded frames in playback order plus timing, transparency, disposal, and blend metadata. Temporal/video models operate on that sequence, and the service rebuilds APNG or GIF from the enhanced frames and preserved metadata. The service must not use a lossy video transcode as the canonical intermediate.

If the chosen temporal model only supports RGB, transparency is not flattened onto a background colour. RGB is enhanced through the temporal model; alpha is reconstructed separately through faithful interpolation or edge-aware preservation, then recombined with the enhanced RGB output.

Cloud temporal enhancement is all-frames or not offered. The service may reject inputs that exceed product limits (frame count, pixel count, file size, queue timeout), but it must not silently sample frames, drop frames, or AI-enhance only part of the animation.

Cloud temporal enhancement outputs APNG by default to preserve true colour and transparency. GIF is available only as an explicit compatibility export, because it quantizes frames to 256 colours and is a quality trade-off.

Uploaded source files and generated results are kept only for a short cloud retention window so long-running jobs can finish and users can recover downloads after refresh or transient network failures. The service must delete both automatically after the retention window and must let users request immediate deletion.

Cloud temporal enhancement runs as an asynchronous cloud job, not a single long synchronous request. The UI exposes upload, queue, processing, encoding, ready, failed, expired, and deleted states, and provides a recovery link that works during the cloud retention window.

## Considered Options

- **Hybrid opt-in temporal enhancement (chosen)** — preserves the local-first privacy promise for ordinary workflows while enabling the best-quality animated AI result when the user explicitly accepts upload.
- **Browser-only** — preserves the strongest privacy story, but keeps full animated AI effectively unavailable or unusably slow.
- **Independent per-frame cloud AI** — enhances every frame but can introduce temporal flicker because each frame is reconstructed without neighbouring-frame context.
- **Cloud-first AI** — maximizes speed and device coverage, but changes the product's trust posture too broadly and weakens the privacy-by-architecture differentiator.

## Consequences

- ADR-0001 is narrowed, not discarded: browser-only remains the default architecture, with this explicit v5 exception.
- ADR-0006 remains valid for local animated AI; cloud temporal enhancement is the path that can supersede first-frame-only when the user opts in.
- The UI must distinguish local processing from upload-based cloud temporal enhancement before a run starts.
- The GPU service needs model/runtime support for temporal consistency, not only still-image model batching.
- The product now needs operational decisions that did not exist before: GPU provider, upload limits, retention policy, abuse controls, queueing, and failure handling.
- v5 does not require user accounts for cloud temporal enhancement, but the service must enforce anonymous limits through file/frame/pixel caps, queue concurrency, rate limits, and retry limits.
- The existing frontend can remain on Cloudflare Pages/R2. Heavy temporal inference runs in an independent GPU service; Cloudflare Workers may broker jobs but do not run GPU inference.

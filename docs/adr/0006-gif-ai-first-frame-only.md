# GIF AI enhancement is first-frame-only

v2 adds per-frame enhancement for animated GIFs, but only in faithful mode. In AI mode, only the first frame is enhanced; the rest are upscaled by faithful interpolation when re-assembling the GIF.

## Context

The whole product is browser-only (ADR-0001) — no server, no server-side GPU. Real-ESRGAN inference on a single frame takes seconds even on capable hardware. An animated GIF commonly has tens to low-hundreds of frames, so AI-per-frame would mean minutes-to-tens-of-minutes of WebGPU work while the tab holds every frame's pixel data in memory. That is not "slow", it is unusable, and risks tab crashes on larger GIFs.

## Decision

For animated GIFs, AI mode enhances only the first frame. The remaining frames are processed by faithful (Lanczos) interpolation when the GIF is re-assembled, so the output is still a valid, full-length animated GIF at the target resolution — just not AI-enhanced beyond frame one. Faithful mode processes every frame, and is the real value for GIFs (instant, and GIF's 256-colour ceiling discards the fine detail AI would add anyway).

## Why not limit AI to the first N frames, or sample frames?

A partially-AI-enhanced GIF looks disjointed — the first frames look noticeably different from the rest. Sampling frames introduces the same seam. "First frame only" is a single, honest boundary the UI can state plainly ("AI enhances the first frame; faithful handles the rest"). When/if a future version can run AI on a server GPU or a much faster in-browser model, this decision is easy to revisit.

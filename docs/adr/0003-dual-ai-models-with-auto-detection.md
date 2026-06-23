# Dual AI models (general + anime) with automatic content detection

We ship two Real-ESRGAN models: a general model for photos and an anime model for illustrations, and switch between them automatically based on a lightweight content-type classifier run on the uploaded image. The general model loads on first use; the anime model loads lazily only when anime/illustration content is detected or the user manually selects it.

A single general model would produce visible artifacts on anime (over-sharpening, jagged lines), and an anime-only model would blur photos. Since output quality is the product's reason to exist, shipping both — at the cost of implementation complexity and a larger total download footprint — is justified. The general model loads by default to keep first-load weight at ~65MB; the anime model's ~18MB is deferred until needed.

## Considered Options

- **Dual models + auto-detection (chosen)** — best quality across both content types, lazy-loaded
- **Single general model** — simpler, smaller, but loses the anime audience to competitors
- **Dual models + manual selection** — simpler detection logic but pushes the decision onto users who don't know how to choose

## Consequences

- A content-type classifier runs on every uploaded image (cheap, in-browser)
- Two model files to host, version, and cache (stored in R2, see ADR-0004)
- Users can manually override a misclassification via a UI toggle

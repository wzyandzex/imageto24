# AI model routing with automatic detection and expert override

We route AI enhancement to the model expected to produce the best result for the source. v1 shipped two Real-ESRGAN models: a general model for photos and an anime model for illustrations. v5 extends this from a fixed dual-model choice to model routing: automatic by default, based on content type, input format, and whether the source is animated, with an expert override for users who know they want a different model.

A single general model would produce visible artifacts on anime (over-sharpening, jagged lines), and an anime-only model would blur photos. Additional models increase download size, hosting complexity, and model QA burden, but output quality is the product's reason to exist. Users should not have to understand model names to get the best result, so automatic routing remains the default. Manual model selection is an expert control, not the primary workflow.

## Considered Options

- **Automatic model routing + expert override (chosen)** — best quality by default while keeping escape hatches for advanced users and model testing
- **Single general model** — simpler, smaller, but loses the anime/illustration audience to competitors and cannot specialize for animated sources
- **Manual model selection** — transparent but pushes model knowledge onto users who do not know how to choose
- **Automatic only, no override** — simplest for casual users but too rigid when the classifier is wrong or an expert wants a specific model

## Consequences

- A content-type classifier runs on uploaded images to support default routing
- Model metadata must describe each model's best-fit content, runtime target, scale factor, and availability
- Model files need hosting, versioning, caching, and compatibility checks (stored in R2 for local models; cloud models may live with the GPU service)
- Users can manually override routing from an expert UI

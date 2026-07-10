# Enhancement strength is an alpha blend, not a model parameter

v4 adds a 0–100% "enhancement strength" slider in AI mode. The strength controls a per-pixel alpha blend between the AI-upscaled output and the faithful (Lanczos) upscaled output — not a parameter of the AI model itself.

## Context

Users asked for control over how aggressively AI reconstruction is applied. Pure AI output can look over-sharpened or unnatural on some content (skin tones, soft photographic detail). Without a slider, the only escape is dropping to faithful mode entirely, losing all AI benefit.

Real-ESRGAN (and ONNX models generally) expose no "strength" or "aggressiveness" knob at inference time. The model takes an input image and produces a fixed 4× output. So "strength" must be mapped to something else.

## Decision

The slider is an **alpha blend ratio** α ∈ [0,1]: `output = α × aiUpscaled + (1 − α) × lanczosUpscaled`, computed per pixel at the target resolution. A new blending-upscaler deep module runs both the AI and faithful upscalers on the same source and blends their outputs. At α = 1 (default) the orchestrator skips the blend and calls the AI upscaler directly, so default behaviour is unchanged.

## Why not the alternatives

- **Multiple models (light/heavy):** would require shipping and downloading additional ~65MB model files, doubling bandwidth and memory for a feature most users won't push past the default. The difference between a "light" and "heavy" RRDB configuration is also not clearly correlated with what users perceive as "strength."
- **Repeated inference (N passes):** multiplies the already-slow AI inference time by N. A 4K single image taking 3× longer for marginal quality gain is unacceptable; for the common case it makes the slider feel broken.
- **Post-process sharpening:** doesn't change what the AI reconstructed — only adjusts contrast at edges. Users would correctly feel the slider "isn't really doing AI differently." It's a filter, not strength.

The alpha blend is the only option that is deterministic, runs in constant time (one extra faithful pass, which is fast), requires no new dependencies, and produces a linear, predictable mapping from slider position to visual result.

## Consequence

The slider is hidden for local animated AI inputs. Blending the AI-enhanced first frame (ADR-0006) against faithful-subsequent frames would make the first frame visibly different from the rest — frame-to-frame inconsistency. Rather than offer a control that degrades local animation quality, the UI hides it for local animated AI and states this honestly.

v5 cloud temporal enhancement is different: the whole animation is processed consistently, so enhancement strength and presets can apply to the complete animation with one uniform value across all frames.

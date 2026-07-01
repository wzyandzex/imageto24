# Animated output format is device-determined: APNG when WebCodecs is available, GIF otherwise

v3's animated output is APNG (true-colour) when the browser supports the WebCodecs `ImageDecoder` API, and GIF (256-colour) when it does not. The format is not user-selectable.

## Context

v2 always output animated results as GIF, which caps each frame at 256 colours. For GIF inputs that's an inherent source-format limit. But v3 adds animated WebP input, which is true-colour — quantizing its enhanced frames to 256 colours throws away the colour fidelity the upscaler worked to preserve. So v3 needs a true-colour animated output container.

The only viable browser-side true-colour animated encoder is UPNG.js writing APNG. There is no mature browser-side animated WebP encoder, and AVIF animated encoding is even less mature. APNG plays natively in every modern browser, so it's the right true-colour container.

But APNG output only makes sense if the *input* frames were decoded losslessly. For WebP input, lossless frame decode requires the WebCodecs `ImageDecoder` API, which is absent on older Safari/Firefox. On those browsers the wasm-decoded frames are still available, but the cleanest true-colour path is gated behind WebCodecs — so APNG output is tied to WebCodecs availability.

## Decision

The animated output format is determined by device capability, detected per-run via `typeof ImageDecoder !== 'undefined'`:

- **WebCodecs available** → decode WebP frames via `ImageDecoder`, encode APNG via UPNG.js. True-colour, transparency preserved.
- **WebCodecs absent** → decode via wasm fallback, encode GIF via gifenc (256-colour). Universal, never a hard error (ADR-0002).

The format is not user-selectable. Letting a user on a WebCodecs-capable browser "choose GIF" would let them pick the worse option unknowingly; letting a user without WebCodecs "choose APNG" would fail or lie. The UI states the actual output and the reason for any degradation honestly.

## Why not gate on a different capability, or let the user pick?

Gating on "can the browser encode APNG" alone (ignoring decode) would produce APNG output from wasm-decoded frames, which is technically possible but conflates two independent capabilities and complicates the deps wiring. Tying the whole path to WebCodecs (decode + the APNG-encode pair) keeps one clean capability boundary.

A user toggle adds a choice with no good answer for most users (who don't know what WebCodecs or APNG are). Automatic detection with honest messaging is consistent with ADR-0002's graceful-degradation philosophy.

## v4 exception: APNG inputs always output APNG

v4 adds APNG as an *input* format. The device-determined rule above was premised on **WebP** input, whose *decode* genuinely gates on WebCodecs — hence APNG output was tied to WebCodecs availability. But APNG *encoding* (UPNG.js) is pure JavaScript and runs on every browser; it does not depend on WebCodecs. And APNG inputs are decoded (via WebCodecs or the pngjs fallback) into true-colour frames regardless of device.

Therefore: **APNG inputs always produce APNG output (true-colour), never degraded to GIF.** The device-determined APNG-or-GIF split continues to apply to WebP inputs (whose decode gates on WebCodecs), but APNG inputs are an exception — the input format itself guarantees a true-colour-capable decode path and a universal encode path, so there is no device capability left to gate on.

This is not a contradiction of the rule but a narrowing: "output is device-determined" holds when the input format's decode or the output's encode is device-gated. For APNG, neither is.

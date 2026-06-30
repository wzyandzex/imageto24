# Third-Party Licenses

This project (imageto24) is released under its own license, but bundles and/or
serves third-party assets that retain their original licenses. The licenses below
apply to those assets only.

## ONNX Runtime Web

- License: MIT License
- Copyright (c) Microsoft Corporation
- Used: in-browser inference engine for AI Enhance mode.
- Source: https://github.com/microsoft/onnxruntime
- Full text: https://github.com/microsoft/onnxruntime/blob/main/LICENSE

## Real-ESRGAN

- License: BSD 3-Clause License
- Copyright (c) 2021, Real-ESRGAN contributors (Xintao Wang et al.)
- Used: the AI Enhance "general" (photo) super-resolution model weights,
  downloaded at runtime from Cloudflare R2 (ADR-0004) and run via ONNX Runtime
  Web. **The model weights are NOT redistributed under imageto24's license** —
  they remain licensed under the BSD 3-Clause above (see PRD "Further Notes:
  Real-ESRGAN licensing").
- Source: https://github.com/xinntao/Real-ESRGAN
- Full text: https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE

The ONNX-converted general model served from R2 is derived from Real-ESRGAN and
inherits its BSD 3-Clause license. Attribution is surfaced in-app on the AI
Enhance option (model name + license); the full license text and source links
above live in this file, shipped with the source distribution.

## gifuct-js

- License: MIT License
- Used: animated-GIF decoder (issue #18). Parses a GIF and decompresses each
  frame into per-frame pixel data for the faithful per-frame upscale path.
  Lazy-loaded inside the worker-bound codec so non-animated users never download
  it.
- Source: https://github.com/matt-way/gifuct-js
- Full text: https://github.com/matt-way/gifuct-js/blob/master/LICENSE

## gifenc

- License: MIT License
- Used: animated-GIF encoder (issue #18). Re-encodes the upscaled frames into a
  playable animated GIF (256-colour per-frame quantization, transparency + timing
  preserved). Lazy-loaded inside the worker-bound codec.
- Source: https://github.com/mattdesl/gifenc
- Full text: https://github.com/mattdesl/gifenc/blob/master/LICENSE.md

## heic2any

- License: MIT License
- Used: HEIC/HEIF decoder (issue #15). Converts iPhone HEIC photos to PNG in the
  browser via the libheif WASM build, lazy-loaded so only HEIC users download it.
- Source: https://github.com/alexcorvi/heic2any
- Full text: https://github.com/alexcorvi/heic2any/blob/master/LICENSE.txt

## @jsquash/webp (wasm WebP fallback)

- License: MIT License
- Used: animated-WebP *wasm fallback* decoder (issue #26). On devices without
  WebCodecs `ImageDecoder`, this libwebp-based wasm decoder provides the
  best-effort decode. Note: it exposes a still-image decode only — there is no
  mature per-frame animated-WebP wasm decoder in the browser ecosystem — so the
  fallback is honest single-frame degradation (ADR-0002). Lazy-loaded inside the
  worker-bound codec so non-WebP users never download it.
- Source: https://github.com/jamsinclair/jsquash
- Full text: https://github.com/jamsinclair/jsquash/blob/main/packages/webp/LICENSE

## upng-js (UPNG.js)

- License: MIT License
- Used: animated-APNG encoder (issue #27). On WebCodecs-capable devices the
  enhanced frames are re-encoded as a playable true-colour APNG via UPNG.js
  (`cnum: 0` ⇒ lossless, no 256-colour quantization — the colour-fidelity win of
  v3, ADR-0007). PNG colour type 6 (RGBA 8-bit/channel) carries transparency
  natively; per-frame delays preserve the original timing. Lazy-loaded inside the
  worker-bound codec, so a user who never produces APNG output (stills, or
  animated output on a non-WebCodecs device) never downloads it (~30KB).
- Source: https://github.com/photopea/UPNG.js
- Full text: https://github.com/photopea/UPNG.js/blob/master/LICENSE

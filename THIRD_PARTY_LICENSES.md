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

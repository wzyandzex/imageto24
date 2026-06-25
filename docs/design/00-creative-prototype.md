# Creative Prototype Prompt for gpt-image-2

> 单一总览提示词，仅描述用户故事和功能，不约束视觉细节，让生图模型自由发挥创意。

## Prompt

```
A product design exploration for "imageto24" — a free, open-source, privacy-first browser-based image upscaler. Design a creative, unique, and visually distinctive single-page web application prototype. Do NOT use generic templates, boring card layouts, or conventional dashboards. Be bold and original in layout, visual metaphor, and interaction design.

WHAT THIS PRODUCT DOES:

The user visits a single web page in their browser and can:

1. DROP IMAGES — Drag-and-drop or file-pick one or multiple images (JPEG, PNG, WebP, AVIF, GIF). The experience of uploading should feel intuitive and inviting, not just a boring dashed-border box.

2. CHOOSE A PHILOSOPHY — Select between two fundamentally different upscaling modes:
   - "Faithful": Mathematically lossless Lanczos interpolation. The output is a perfect, provable enlargement of the original. Zero information invented, zero information lost. Think: archivist, photographer, forensic — people who treat images as evidence.
   - "AI Enhance": Uses Real-ESRGAN neural networks running via WebGPU in the browser to reconstruct plausible detail, making blurry images visibly sharper. Think: casual user wanting their old phone photos to look great on a 4K monitor. The UI must honestly communicate this is non-lossless — detail is invented, not recovered.
   The mode selection should feel like choosing between two different worldviews, not just toggling a switch.

3. PICK A TARGET — Choose resolution: 1080p, 2K, or 4K. Or go advanced with exact upscale factor (2x/3x/4x) or custom pixel dimensions. The user should feel a sense of ambition when selecting 4K.

4. CONFIGURE OUTPUT — Choose format (PNG, lossless WebP, lossy WebP, JPEG). Option to strip EXIF metadata. In Faithful mode, only lossless formats are allowed.

5. WATCH IT WORK — See a real-time progress indicator while the image is processed entirely in the browser. For batch uploads, see a queue with per-image status. The first time AI mode is used, a ~65MB model downloads — this wait should be communicated elegantly.

6. COMPARE AND DOWNLOAD — View a before/after comparison of the original vs upscaled image. Download the result. For batches, download all results at once.

7. FEEL SAFE — The entire experience must radiate trust. No image data ever leaves the device. There is no server, no backend, no upload. This is verifiable (open source). The privacy promise is architectural, not marketing. Make this tangible in the design.

8. WORK EVERYWHERE — If the browser can't run AI mode (no WebGPU), the tool gracefully degrades: AI is clearly disabled with a friendly explanation, and Faithful mode works perfectly. The tool never breaks.

9. BE FREE — No accounts, no paywalls, no login. A donation link for supporters.

DESIGN DIRECTION HINTS (interpret freely):
- The two modes (Faithful vs AI) represent a tension between truth and beauty — explore this creatively.
- The before/after comparison is the emotional payoff moment — make it dramatic.
- Privacy-by-architecture is the brand soul — make it felt, not just stated.
- The product name "imageto24" suggests transformation to 24fps cinema quality — play with this metaphor if inspired.
- Think beyond typical SaaS tool UIs. Consider: immersive, cinematic, dark-mode-first, or even playful approaches.
```

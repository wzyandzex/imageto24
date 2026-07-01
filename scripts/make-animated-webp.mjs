// One-off generator for a real, browser-decodable animated WebP e2e fixture.
// Run: node scripts/make-animated-webp.mjs  -> writes e2e/fixtures/animated.webp
//
// Why this path: building a valid animated WebP by hand is fragile — a
// hand-assembled RIFF container (VP8X+ANIM+ANMF) passes a naive chunk walk but
// real decoders (sharp/libvips, Chromium's <img>, WebCodecs) reject it, because
// the ANMF frame bitstream's framing must match exactly what libwebp emits.
// There is no command-line animator (ffmpeg/ImageMagick) in this environment,
// and `@jsquash/webp` exposes only still encode/decode. The robust, dependency-
// free route is: hand-build a real animated GIF89a (a trivial, well-understood
// container) and transcode it to animated WebP with sharp's libvips, which
// *reads* the animated GIF and emits a libwebp-canonical animated WebP that
// every real decoder accepts.
//
// Why hand-build the GIF rather than use `makeGif` (e2e/fixtures/gif.ts): that
// fixture emits 1×1 frames, and libvips collapses such tiny, equal-delay frames
// into a single still on transcode (verified). 16×16 frames with three distinct
// gradients and three distinct delays survive as a 3-frame animation.
//
// The fixture is intentionally small (16×16 frames) so the committed blob is
// tiny and a 4K faithful upscale is a meaningful but fast operation. Each frame
// is a 256-step gradient across the global colour table (not a flat colour), so a
// faithful Lanczos 4× upscale yields hundreds of thousands of distinct colours
// — forcing UPNG.js's `cnum:0` lossless path to emit PNG colour type 6
// (true-colour RGBA) rather than a ≤256-colour palette (type 3). This is what
// makes the e2e's `colourType===6` assertion meaningful. Delays land at
// 100/150/200 ms in the WebP (encoded as 10/15/20 centiseconds in the GIF, which
// sharp/libwebp converts to the WebP ANMF duration field in milliseconds).
import sharp from "sharp";
import { writeFileSync } from "node:fs";

const SIZE = 16;
const DELAYS_CS = [10, 15, 20]; // GIF centiseconds → 100/150/200 ms in WebP

/**
 * 256-colour global table spanning a wide hue/value range so each frame can
 * carry a real gradient (>256 distinct colours after the faithful Lanczos
 * upscale interpolates between entries). This is what forces UPNG.js's lossless
 * path to true-colour (PNG colour type 6, RGBA): a frame with ≤256 colours is
 * palette-encodable without loss, so UPNG (cnum:0 ⇒ "lossless", not "force
 * RGBA") legitimately emits colour type 3 for it. A genuine gradient can only
 * be preserved losslessly as true-colour, which is the fidelity claim #28
 * asserts on the downloaded APNG.
 */
function palette() {
  const t = [];
  for (let i = 0; i < 256; i++) {
    // Diagonal hue ramp across the full RGB cube: r and b rise, g falls.
    t.push([i, 255 - i, (i * 7) & 255]);
  }
  return t;
}
const PALETTE = palette();

/**
 * Build a real animated GIF89a: a 256-colour gradient global table, a
 * NETSCAPE2.0 looping extension, then one image per frame — each a Graphic
 * Control Extension (delay + disposal) followed by an Image Descriptor and an
 * LZW-coded SIZE×SIZE diagonal gradient over the palette. Distinct per-frame
 * gradients + distinct delays keep libwebp from collapsing the frames on
 * transcode (libvips folds identical tiny frames into a single still).
 */
function buildAnimatedGif() {
  const bytes = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    SIZE & 255,
    (SIZE >> 8) & 255, // canvas width
    SIZE & 255,
    (SIZE >> 8) & 255, // canvas height
    0xf7, // GCT present, 256 colours
    0,
    0, // bg index, pixel aspect
  ];
  // Global colour table: the 256-colour gradient ramp from `PALETTE`.
  for (let i = 0; i < 256; i++) {
    const c = PALETTE[i];
    bytes.push(c[0], c[1], c[2]);
  }
  // NETSCAPE2.0 application extension: loop forever.
  bytes.push(0x21, 0xff, 0x0b);
  for (const ch of "NETSCAPE2.0") bytes.push(ch.charCodeAt(0));
  bytes.push(3, 1, 0, 0, 0);

  for (let f = 0; f < DELAYS_CS.length; f++) {
    // Graphic Control Extension: disposal=0, no transparency, delay in cs.
    bytes.push(0x21, 0xf9, 4, 0x00);
    bytes.push(DELAYS_CS[f] & 255, (DELAYS_CS[f] >> 8) & 255, 0, 0);
    // Image Descriptor: full canvas, no local colour table.
    bytes.push(0x2c, 0, 0, 0, 0);
    bytes.push(SIZE & 255, (SIZE >> 8) & 255, SIZE & 255, (SIZE >> 8) & 255, 0);
    // LZW image data: min code size 8 (256-colour table). Each frame is a
    // diagonal gradient over the 256-colour palette — every row is a rotated
    // ramp, offset by the frame index so the three frames differ. A frame with
    // 256 distinct colours cannot be palette-compressed losslessly below 256,
    // so UPNG must emit true-colour (colour type 6) — the fidelity the e2e
    // asserts. (At the 8×8 source there are at most 64 pixels, but the faithful
    // Lanczos upscale to 3840×3840 interpolates thousands of intermediate
    // colours across the gradient edges, well above 256.)
    bytes.push(8);
    const px = [];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        px.push((x * 8 + y * 32 + f * 85) & 255);
      }
    }
    bytes.push(...lzwSubblocks(px));
  }
  bytes.push(0x3b); // GIF trailer
  return Buffer.from(bytes);
}

/**
 * LZW-encode a flat index stream for GIF and emit it as 255-byte sub-blocks
 * (length-prefixed) + a 0 terminator. Min code size 8 (256-colour table) ⇒
 * clear=256, EOI=257; codes start at 9 bits, growing to 10/11/12 as the
 * dictionary fills (512/1024/2048 entries).
 */
function lzwSubblocks(indices) {
  const CLEAR = 256;
  const EOI = 257;
  let codeSize = 9;
  const dict = new Map();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  let next = 258;
  const out = [];
  let buf = 0;
  let bufBits = 0;
  const emit = (code) => {
    buf |= code << bufBits;
    bufBits += codeSize;
    while (bufBits >= 8) {
      out.push(buf & 255);
      buf >>= 8;
      bufBits -= 8;
    }
  };
  emit(CLEAR);
  let w = String.fromCharCode(indices[0]);
  for (let i = 1; i < indices.length; i++) {
    const k = String.fromCharCode(indices[i]);
    if (dict.has(w + k)) {
      w += k;
    } else {
      emit(dict.get(w));
      if (next < 4096) dict.set(w + k, next++);
      if (next === 511 || next === 1023) codeSize++;
      w = k;
    }
  }
  emit(dict.get(w));
  emit(EOI);
  if (bufBits > 0) out.push(buf & 255);
  // Pack into ≤255-byte sub-blocks + terminator.
  const packed = [];
  for (let i = 0; i < out.length; i += 255) {
    const len = Math.min(255, out.length - i);
    packed.push(len);
    for (let j = 0; j < len; j++) packed.push(out[i + j]);
  }
  packed.push(0);
  return packed;
}

const gif = buildAnimatedGif();
// Transcode: libvips reads the animated GIF and emits a libwebp-canonical
// animated WebP (VP8X+ANIM+ANMF). This is the file real decoders accept.
const webp = await sharp(gif, { animated: true })
  .webp({ loop: 0 })
  .toBuffer();

writeFileSync(new URL("../e2e/fixtures/animated.webp", import.meta.url), webp);

// Self-verify: sharp must re-read it as a 3-page animation (proves it is a valid
// animated WebP that real decoders accept), and the chunk list must carry the
// extended-container shape (VP8X+ANIM+N×ANMF). detectAnimation only walks the
// chunk list; sharp's re-read is the stronger "a real decoder accepts it" check.
const meta = await sharp(webp, { animated: true }).metadata();
const chunks = [];
let pos = 12;
while (pos + 8 <= webp.length) {
  const fourcc = String.fromCharCode(
    webp[pos],
    webp[pos + 1],
    webp[pos + 2],
    webp[pos + 3],
  );
  const size =
    webp[pos + 4] |
    (webp[pos + 5] << 8) |
    (webp[pos + 6] << 16) |
    ((webp[pos + 7] >>> 0) * 0x1000000);
  chunks.push(`${fourcc}:${size}`);
  pos += 8 + size + (size % 2);
}
console.log("wrote e2e/fixtures/animated.webp");
console.log("bytes", webp.length);
console.log("chunks", chunks.join(" "));
console.log("sharp re-read pages", meta.pages, "delay(cs)", JSON.stringify(meta.delay));
const anmf = chunks.filter((c) => c.startsWith("ANMF")).length;
if (meta.pages !== DELAYS_CS.length || anmf !== DELAYS_CS.length) {
  console.error(
    `FAIL: expected ${DELAYS_CS.length} pages/ANMF, got pages=${meta.pages} ANMF=${anmf}`,
  );
  process.exit(1);
}
console.log("OK: 3-page animated WebP verified");

/**
 * A multi-colour animated-GIF fixture for the Playwright e2e suite (issue #28).
 *
 * `makeGif` (gif.ts) emits 1×1 single-colour frames — perfect for detection /
 * routing assertions, but its frames stay a flat colour through the faithful
 * Lanczos upscale. UPNG.js (cnum:0 ⇒ "lossless", not "force RGBA") legitimately
 * emits PNG colour type 3 (palette) for such a frame, since a ≤256-colour image
 * is losslessly palette-encodable. That makes `colourType === 6` a false
 * assertion against `makeGif`'s output: palette output there is *not* a
 * fidelity loss, just a smaller encoding of the same pixels.
 *
 * To assert the *true-colour* fidelity win (issue #27 — APNG carries full RGBA,
 * no 256-colour ceiling) the fixture must carry more than 256 colours after the
 * upscale. This builder emits an 8×8 animated GIF whose every frame is a
 * diagonal gradient over a 256-colour global palette (each row a rotated ramp,
 * offset per frame so the frames differ). The faithful Lanczos upscale to 4K
 * interpolates thousands of intermediate colours across the gradient edges —
 * well above 256 — so UPNG is forced to emit colour type 6 (true-colour RGBA),
 * which is exactly the outcome the e2e asserts.
 *
 * Pure Node (no sharp, no libvips): it is a hand-assembled GIF89a, identical in
 * spirit to `makeGif` but with a real LZW-coded 8×8 gradient per frame.
 */

const SIZE = 8;
const DELAYS_CS = [10, 10, 10]; // GIF centiseconds → 100ms each

/** Build the 256-entry global colour table: a diagonal ramp across RGB. */
function palette(): number[] {
  const t: number[] = [];
  for (let i = 0; i < 256; i++) {
    t.push(i, 255 - i, (i * 7) & 255);
  }
  return t;
}

/**
 * LZW-encode a flat index stream for GIF and emit it as ≤255-byte sub-blocks
 * (length-prefixed) + a 0 terminator. Min code size 8 (256-colour table) ⇒
 * clear=256, EOI=257; codes start at 9 bits, growing to 10/11/12 as the
 * dictionary fills (512/1024/2048 entries).
 */
function lzwSubblocks(indices: number[]): number[] {
  const CLEAR = 256;
  const EOI = 257;
  let codeSize = 9;
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i++) dict.set(String.fromCharCode(i), i);
  let next = 258;
  const out: number[] = [];
  let buf = 0;
  let bufBits = 0;
  const emit = (code: number) => {
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
      emit(dict.get(w)!);
      if (next < 4096) dict.set(w + k, next++);
      if (next === 511 || next === 1023 || next === 2047) codeSize++;
      w = k;
    }
  }
  emit(dict.get(w)!);
  emit(EOI);
  if (bufBits > 0) out.push(buf & 255);
  // Pack into ≤255-byte sub-blocks + terminator.
  const packed: number[] = [];
  for (let i = 0; i < out.length; i += 255) {
    const len = Math.min(255, out.length - i);
    packed.push(len);
    for (let j = 0; j < len; j++) packed.push(out[i + j]);
  }
  packed.push(0);
  return packed;
}

/**
 * Build a real, browser-decodable 3-frame animated GIF89a with 8×8 gradient
 * frames over a 256-colour palette. Each frame is a Graphic Control Extension
 * (delay + disposal) followed by an Image Descriptor + LZW image data. The
 * three frames use the same gradient shape but a per-frame index offset so they
 * are visibly distinct (keeps any decoder from collapsing them).
 */
export function makeGradientGif(): Buffer {
  const bytes: number[] = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    SIZE & 255,
    (SIZE >> 8) & 255, // canvas width
    SIZE & 255,
    (SIZE >> 8) & 255, // canvas height
    0xf7, // packed: GCT present, 256 colours (2^(7+1))
    0,
    0, // background index, pixel aspect
    ...palette(),
  ];
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
    bytes.push(
      SIZE & 255,
      (SIZE >> 8) & 255,
      SIZE & 255,
      (SIZE >> 8) & 255,
      0,
    );
    // LZW image data: min code size 8 (256-colour table).
    bytes.push(8);
    const px: number[] = [];
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

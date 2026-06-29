/**
 * Animated-GIF test fixtures for the Playwright e2e suite (issue #16).
 *
 * Several e2e specs need a real, browser-decodable GIF — both animated
 * (multi-frame) and still (single-frame). Generated at runtime so the suite
 * stays self-contained with no committed binary assets, mirroring `png.ts`.
 *
 * The GIFs are minimal (1×1 frames, 2-colour palette) but valid: the LZW
 * image data is a real, decodable compressed stream so the browser's
 * `createImageBitmap` yields a first frame the faithful upscale can run on.
 * Each frame in an animated GIF is paired with a Graphic Control Extension so
 * `detectAnimation` counts it as a frame.
 */

/** A Graphic Control Extension: introducer + label + 4-byte sub-block + terminator. */
function gce(): number[] {
  return [
    0x21, // extension introducer
    0xf9, // graphic control label
    0x04, // block size (4)
    0x00, // packed (no disposal, no transparency)
    0x0a, 0x00, // delay (100ms, little-endian)
    0x00, // transparent colour index
    0x00, // block terminator
  ];
}

/**
 * Build the LZW-compressed image data for a single 1×1 frame with a 2-colour
 * palette.
 *
 * LZW for a 1-pixel, 2-colour image: min code size 2 ⇒ clear code 4, end code 5,
 * first data code 6. Codes start at 3 bits wide and pack LSB-first into bytes.
 *
 * The stream is: clear(4) + indexN + end(5). Choosing index 1 (white) packs
 * into the bytes `[0x4c, 0x01]`: bits 0-2 = 100 (clear, code 4), bits 3-5 = 001
 * (index 1), bits 6-8 = 101 (end, code 5). This is the canonical minimal LZW
 * block — accepted by every GIF decoder.
 */
function lzwImageData(): number[] {
  return [
    0x02, // LZW minimum code size
    0x02, // sub-block size (2 bytes follow)
    0x4c, 0x01, // clear(4) + index1(white) + end(5), packed LSB-first into bits
    0x00, // sub-block terminator
  ];
}

/** An Image Descriptor for a 1×1 frame with no Local Color Table + LZW data. */
function imageDescriptor(): number[] {
  return [
    0x2c, // image descriptor introducer
    0x00, 0x00, // left
    0x00, 0x00, // top
    0x01, 0x00, // width  (1)
    0x01, 0x00, // height (1)
    0x00, // packed (no LCT, not interlaced)
    ...lzwImageData(),
  ];
}

/**
 * Build a real, browser-decodable GIF89a with the given number of frames.
 *
 * Layout: signature(6) + LSD(7) + GCT(6 for 2 colours) + frames + trailer.
 * Each frame is a GCE + Image Descriptor pair — the canonical animated-GIF
 * shape. The first frame is what the browser decodes; the rest satisfy
 * `detectAnimation`'s frame count.
 *
 * @param frames number of frames (≥1). `1` ⇒ a still GIF; `>1` ⇒ animated.
 */
export function makeGif(frames: number): Buffer {
  const bytes: number[] = [
    // Signature + version: "GIF89a"
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    // Logical Screen Descriptor: 1×1 canvas, packed 0x80 (GCT present, 2 colours).
    0x01, 0x00, // width 1
    0x01, 0x00, // height 1
    0x80, // packed: has GCT, size = 2^(0+1) = 2
    0x00, // background colour index
    0x00, // pixel aspect ratio
    // Global Color Table: 2 entries × 3 bytes = 6 bytes.
    0x00, 0x00, 0x00, // colour 0: black
    0xff, 0xff, 0xff, // colour 1: white
  ];
  for (let i = 0; i < frames; i++) {
    bytes.push(...gce());
    bytes.push(...imageDescriptor());
  }
  bytes.push(0x3b); // trailer
  return Buffer.from(bytes);
}

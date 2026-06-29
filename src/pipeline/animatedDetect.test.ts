// @vitest-environment node
//
// Animated-image detection tests (issue #16). The detection function is a pure
// header scan — no decode, no codec — so it runs under Vitest in Node with
// hand-built byte buffers. We cover the acceptance criteria: a multi-frame GIF
// is detected (isAnimated + frameCount), a single-frame GIF and a non-GIF are
// not, and animated WebP / APNG are detected as such (detection-only; v2 still
// treats them as stills).
//
// The GIF fixtures are built byte-for-byte from the GIF spec so the scan walks a
// real stream — image descriptors, graphic-control extensions, LZW sub-blocks.
// No committed binary needed: the spec is small and the construction is exact.
import { describe, expect, it } from "vitest";
import { detectAnimation } from "./animatedDetect";
import type { ImageFormat } from "./types";

/* -------------------------------------------------------------------------- */
/* GIF fixture builders                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Append a Graphic Control Extension (0x21 0xF9 + 4-byte block). Required in an
 * animated GIF (one GCE per frame, carrying the delay). The 4-byte data block is
 * a fixed shape; the scan skips it as a sub-block sequence.
 */
function gce(): number[] {
  return [
    0x21, // extension introducer
    0xf9, // graphic control label
    0x04, // sub-block length (4)
    0x00, // packed (disposal/transparent)
    0x0a, 0x00, // delay (little-endian) — 10 = 100ms
    0x00, // transparent colour index
    0x00, // sub-block terminator
  ];
}

/**
 * Append an Image Descriptor (0x2C) for a 1×1 frame with no Local Color Table,
 * followed by minimal LZW image data (a single zero-length sub-block, so the scan
 * sees a complete, well-formed frame). The pixels themselves are irrelevant —
 * the scan counts descriptors, it never decodes them — but the sub-block shape
 * must be valid so `skipImageDescriptor` advances to the next introducer.
 */
function imageDescriptor(): number[] {
  return [
    0x2c, // image descriptor introducer
    0x00, 0x00, // left
    0x00, 0x00, // top
    0x01, 0x00, // width  (1)
    0x01, 0x00, // height (1)
    0x00, // packed (no LCT)
    // LZW image data: min code size byte + one sub-block + terminator.
    0x02, // LZW min code size
    0x01, 0x00, // sub-block: length 1 + 1 data byte
    0x00, // sub-block terminator
  ];
}

/**
 * Build a GIF89a with a global color table and the given number of frames.
 *
 * Layout: signature(6) + LSD(7) + GCT(6 for a 2-colour table) + frames + trailer.
 * Each frame is a GCE + Image Descriptor pair (the canonical animated-GIF shape
 * — `gifuct-js` will see the same structure in #18). The GCT is two RGB entries.
 */
function buildGif(frames: number): ArrayBuffer {
  const bytes: number[] = [
    // Signature + version: "GIF89a"
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    // Logical Screen Descriptor: 1×1 canvas, packed = 0x80 (has GCT, size = 2^(0+1)=2)
    0x01, 0x00, // width 1
    0x01, 0x00, // height 1
    0x80, // packed: has GCT, 2 colours
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
  return new Uint8Array(bytes).buffer;
}

/** Build a truncated/malformed GIF (valid signature, then garbage). */
function malformedGif(): ArrayBuffer {
  const bytes = [
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
    0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, // LSD, no GCT
    0xff, // unknown introducer — scan bails to still
  ];
  return new Uint8Array(bytes).buffer;
}

/* -------------------------------------------------------------------------- */
/* Animated WebP fixture                                                       */
/* -------------------------------------------------------------------------- */

/** ASCII codes for a four-cc, as the scan reads them. */
function fourcc(s: string): number[] {
  return s.split("").map((c) => c.charCodeAt(0));
}

/** A 32-bit little-endian size prefix as used by RIFF chunks. */
function le32(n: number): number[] {
  // Deconstruct into four bytes, masking the high byte (>>> 0 keeps it unsigned).
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}

/** Build a WebP with an ANIM chunk (animated). VP8X omitted — the scan keys off ANIM. */
function buildAnimatedWebp(): ArrayBuffer {
  // RIFF chunk: "RIFF" + size + "WEBP" + payload. The ANIM chunk is 6 bytes.
  const payload = [...fourcc("ANIM"), ...le32(6), 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
  const riffBody = [...fourcc("WEBP"), ...payload];
  const bytes = [...fourcc("RIFF"), ...le32(riffBody.length), ...riffBody];
  return new Uint8Array(bytes).buffer;
}

/** Build a still WebP (VP8L lossy-ish stub) with no ANIM chunk. */
function buildStillWebp(): ArrayBuffer {
  // A single VP8 chunk — no ANIM. The scan walks the chunk list and finds none.
  const vp8Data = [0x00, 0x00, 0x00, 0x00];
  const payload = [...fourcc("VP8 "), ...le32(vp8Data.length), ...vp8Data];
  const riffBody = [...fourcc("WEBP"), ...payload];
  const bytes = [...fourcc("RIFF"), ...le32(riffBody.length), ...riffBody];
  return new Uint8Array(bytes).buffer;
}

/* -------------------------------------------------------------------------- */
/* APNG fixture                                                                */
/* -------------------------------------------------------------------------- */

/** A 32-bit big-endian size prefix as used by PNG chunks. */
function be32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** CRC32 for PNG chunk checksums (IEEE polynomial; matches the e2e PNG helper). */
function crc32(buf: Uint8Array): number {
  let table: number[] | undefined = (crc32 as unknown as { table?: number[] }).table;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as unknown as { table?: number[] }).table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a PNG chunk: length(4 BE) + type(4) + data + crc(4). */
function pngChunk(type: string, data: number[]): number[] {
  const typeBuf = Buffer.from(type, "ascii");
  const dataBuf = Uint8Array.from(data);
  const crc = crc32(Uint8Array.from([...typeBuf, ...dataBuf]));
  return [...be32(data.length), ...typeBuf, ...data, ...be32(crc)];
}

/** Build a PNG signature (8 bytes). */
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Build an APNG: PNG sig + IHDR + acTL (animation control). */
function buildApng(): ArrayBuffer {
  // IHDR: 4×4 image, 8-bit RGBA (the shape the e2e PNG helper uses).
  const ihdr = pngChunk("IHDR", [
    0x00, 0x00, 0x00, 0x04, // width
    0x00, 0x00, 0x00, 0x04, // height
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth 8, colour type 6 (RGBA)
  ]);
  // acTL: num_frames(4) + num_plays(4). Its presence marks an APNG.
  const actl = pngChunk("acTL", [0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]);
  return new Uint8Array([...PNG_SIG, ...ihdr, ...actl]).buffer;
}

/** Build a still PNG (no acTL chunk). */
function buildStillPng(): ArrayBuffer {
  const ihdr = pngChunk("IHDR", [
    0x00, 0x00, 0x00, 0x04,
    0x00, 0x00, 0x00, 0x04,
    0x08, 0x06, 0x00, 0x00, 0x00,
  ]);
  return new Uint8Array([...PNG_SIG, ...ihdr]).buffer;
}

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe("detectAnimation — GIF (issue #16)", () => {
  it("detects a multi-frame GIF as animated and counts its frames", () => {
    const buf = buildGif(3);
    const scan = detectAnimation(buf, "gif");
    expect(scan.isAnimated).toBe(true);
    // Three image descriptors ⇒ three frames, the exact count #18 will process.
    expect(scan.frameCount).toBe(3);
    expect(scan.animatedWebp).toBe(false);
    expect(scan.apng).toBe(false);
  });

  it("counts a larger multi-frame GIF correctly", () => {
    // A 12-frame GIF — well within the tens-to-low-hundreds the PRD cites. Proves
    // the sub-block / descriptor skipping stays accurate as frames accumulate.
    const scan = detectAnimation(buildGif(12), "gif");
    expect(scan.isAnimated).toBe(true);
    expect(scan.frameCount).toBe(12);
  });

  it("identifies a single-frame GIF as not animated (still)", () => {
    // One frame: the v1 path. It must route to processImage, not processAnimated.
    const scan = detectAnimation(buildGif(1), "gif");
    expect(scan.isAnimated).toBe(false);
    expect(scan.frameCount).toBe(0);
  });

  it("identifies a GIF with no frames (header + trailer) as not animated", () => {
    // A degenerate GIF: signature + LSD + GCT + trailer, no image descriptors.
    // The scan must not crash or count phantom frames.
    const bytes = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD + packed (GCT, 2 colours)
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT (2 entries)
      0x3b, // trailer
    ]).buffer;
    const scan = detectAnimation(bytes, "gif");
    expect(scan.isAnimated).toBe(false);
    expect(scan.frameCount).toBe(0);
  });

  it("falls back to still on a malformed GIF (no crash)", () => {
    // A corrupt stream: valid signature, then an unknown introducer. The scan
    // must bail safely rather than throw or miscount — a malformed GIF is not
    // routed as animated (it would just fail the still decode later instead).
    const scan = detectAnimation(malformedGif(), "gif");
    expect(scan.isAnimated).toBe(false);
    expect(scan.frameCount).toBe(0);
  });

  it("falls back to still when the GIF signature is wrong despite the format hint", () => {
    // formatFromFile said "gif" but the bytes aren't a GIF (e.g. a renamed JPEG).
    // Don't trust the hint past the magic check — route to the still path.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;
    const scan = detectAnimation(bytes, "gif");
    expect(scan.isAnimated).toBe(false);
  });

  it("falls back to still for a too-short buffer (truncated header)", () => {
    // Fewer than 13 bytes — can't even read the LSD. Safe fallback, no throw.
    const scan = detectAnimation(new Uint8Array([0x47, 0x49, 0x46]).buffer, "gif");
    expect(scan.isAnimated).toBe(false);
  });

  it("handles a GIF with extensions (comment/application) between frames", () => {
    // A real animated GIF often carries a comment or Netscape loop extension.
    // The scan must skip extension sub-blocks and keep counting image descriptors
    // — this is the exact shape gifuct-js will also walk in #18.
    const bytes: number[] = [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD + packed
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT
      // Frame 1: GCE + image.
      ...gce(),
      ...imageDescriptor(),
      // Netscape application extension (loop forever) — a 3-byte data block.
      0x21, 0xff, // extension + application label
      0x0b, // block size 11
      ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt(0)),
      0x03, 0x01, 0x00, 0x00, // sub-block: loop count
      0x00, // terminator
      // Frame 2: GCE + image.
      ...gce(),
      ...imageDescriptor(),
      0x3b, // trailer
    ];
    const scan = detectAnimation(new Uint8Array(bytes).buffer, "gif");
    expect(scan.isAnimated).toBe(true);
    expect(scan.frameCount).toBe(2);
  });

  it("skips the LZW minimum-code-size byte before the image data sub-blocks", () => {
    // Regression guard for the e2e fixture shape: a real GIF's image data is
    // `min-code-size byte + sub-blocks`. If the scan misreads the min-code-size
    // byte as a sub-block length, it runs off the stream and miscounts. The
    // canonical minimal LZW block (min code size 2, a 2-byte sub-block, then a
    // 0x00 terminator) is the exact shape the e2e fixture builds — assert it
    // counts correctly across multiple frames.
    const bytes: number[] = [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD + packed (GCT, 2 colours)
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT
      // Frame 1: GCE + image descriptor + real LZW block.
      ...gce(),
      0x2c, // image descriptor
      0x00, 0x00, 0x00, 0x00, // left, top
      0x01, 0x00, 0x01, 0x00, // width, height
      0x00, // packed (no LCT)
      // LZW image data: min code size byte, then a 2-byte sub-block, then terminator.
      0x02, // LZW minimum code size (NOT a sub-block length)
      0x02, // sub-block length (2 bytes follow)
      0x4c, 0x01, // packed LZW codes
      0x00, // sub-block terminator
      // Frame 2 + 3: same shape.
      ...gce(),
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x4c, 0x01, 0x00,
      ...gce(),
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x02, 0x02, 0x4c, 0x01, 0x00,
      0x3b, // trailer
    ];
    const scan = detectAnimation(new Uint8Array(bytes).buffer, "gif");
    expect(scan.isAnimated).toBe(true);
    expect(scan.frameCount).toBe(3);
  });

  it("skips large image-data sub-blocks by length (no per-byte walk), keeping the scan cheap", () => {
    // The PRD/issue call the detection "cheap / milliseconds" — that holds only
    // if the scan advances past each image-data sub-block by its length byte,
    // not by inspecting every data byte. Build a 2-frame GIF whose first frame
    // carries a ~64KB image-data sub-block (255-byte sub-blocks chained, the max
    // GIF allows per sub-block). If the scan walked bytes it would be O(file
    // size); skipping by length keeps it O(number-of-sub-blocks). Either way the
    // *count* must stay 2 — this guards against a regression that misreads a
    // large block length and runs off the stream.
    const bytes: number[] = [
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // "GIF89a"
      0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // LSD + packed (GCT, 2 colours)
      0x00, 0x00, 0x00, 0xff, 0xff, 0xff, // GCT
      // Frame 1: GCE + image descriptor + a large LZW image-data section.
      ...gce(),
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
      0x02, // LZW minimum code size
    ];
    // ~64KB of data: 256 sub-blocks of 255 bytes each, then a terminator. The
    // byte values are irrelevant (never decoded) — only the length framing is.
    for (let i = 0; i < 256; i++) {
      bytes.push(0xff); // sub-block length 255
      for (let j = 0; j < 255; j++) bytes.push(0x00); // padding data
    }
    bytes.push(0x00); // sub-block terminator
    // Frame 2: GCE + image descriptor + minimal LZW.
    bytes.push(...gce());
    bytes.push(0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
    bytes.push(0x02, 0x02, 0x4c, 0x01, 0x00);
    bytes.push(0x3b); // trailer

    const buf = new Uint8Array(bytes).buffer;
    const scan = detectAnimation(buf, "gif");
    expect(scan.isAnimated).toBe(true);
    expect(scan.frameCount).toBe(2);
  });
});

describe("detectAnimation — non-GIF still formats", () => {
  it("identifies a JPEG as a still (never animated)", () => {
    const scan = detectAnimation(new ArrayBuffer(0), "jpeg");
    expect(scan.isAnimated).toBe(false);
    expect(scan.frameCount).toBe(0);
    expect(scan.animatedWebp).toBe(false);
    expect(scan.apng).toBe(false);
  });

  it("identifies an AVIF as a still (animated AVIF is out of scope for v2)", () => {
    const scan = detectAnimation(new ArrayBuffer(0), "avif");
    expect(scan.isAnimated).toBe(false);
  });

  it("identifies a HEIC as a still (a photo format, not animated)", () => {
    const scan = detectAnimation(new ArrayBuffer(0), "heic");
    expect(scan.isAnimated).toBe(false);
  });

  it("identifies a still PNG as a still (no acTL chunk)", () => {
    const scan = detectAnimation(buildStillPng(), "png");
    expect(scan.isAnimated).toBe(false);
    expect(scan.apng).toBe(false);
  });
});

describe("detectAnimation — animated WebP (detection-only, v2 still treats as still)", () => {
  it("detects an animated WebP via its ANIM chunk", () => {
    const scan = detectAnimation(buildAnimatedWebp(), "webp");
    // Detection-only: animatedWebp is true, but isAnimated stays false — v2 routes
    // it to processImage (first frame), not processAnimated (PRD §Out of scope).
    expect(scan.animatedWebp).toBe(true);
    expect(scan.isAnimated).toBe(false);
    expect(scan.frameCount).toBe(0);
  });

  it("identifies a still WebP (no ANIM chunk)", () => {
    const scan = detectAnimation(buildStillWebp(), "webp");
    expect(scan.animatedWebp).toBe(false);
    expect(scan.isAnimated).toBe(false);
  });

  it("falls back to still for a non-RIFF buffer despite the format hint", () => {
    const scan = detectAnimation(new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer, "webp");
    expect(scan.animatedWebp).toBe(false);
    expect(scan.isAnimated).toBe(false);
  });
});

describe("detectAnimation — APNG (detection-only, v2 still treats as still)", () => {
  it("detects an APNG via its acTL chunk", () => {
    const scan = detectAnimation(buildApng(), "png");
    // Detection-only: apng is true, isAnimated stays false — v2 processes the
    // first frame (the PRD's "treated as stills" path for non-GIF animations).
    expect(scan.apng).toBe(true);
    expect(scan.isAnimated).toBe(false);
    expect(scan.frameCount).toBe(0);
  });

  it("falls back to still for a non-PNG buffer despite the format hint", () => {
    const scan = detectAnimation(new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer, "png");
    expect(scan.apng).toBe(false);
    expect(scan.isAnimated).toBe(false);
  });
});

describe("detectAnimation — every format covered", () => {
  // A guard against a new ImageFormat landing without a detection decision: the
  // switch must be exhaustive, so every format returns something sensible.
  const allFormats: ImageFormat[] = ["jpeg", "png", "webp", "avif", "gif", "heic"];
  for (const f of allFormats) {
    it(`returns a still-shaped result for ${f} on an empty buffer`, () => {
      const scan = detectAnimation(new ArrayBuffer(0), f);
      expect(scan.isAnimated).toBe(false);
      expect(scan.frameCount).toBe(0);
    });
  }
});

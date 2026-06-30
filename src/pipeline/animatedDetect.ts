/**
 * Animated-image detection — pure, environment-free (issue #16).
 *
 * This is the foundation of the animated line: a cheap, synchronous scan of an
 * uploaded file that decides whether it is an {@link AnimatedImage}
 * (multi-frame) or a still, and routes accordingly. Per ADR-0006 and the v2
 * PRD, animated GIF and animated WebP are both routed to
 * {@link processAnimated} (WebP lands in issue #26); APNG is *detected* (so we
 * can tell the user honestly that it's treated as a still) but not yet routed.
 *
 * Domain terms follow `CONTEXT.md` "Animated image" / "Frame".
 *
 * The scan reads container structure, never pixels — no LZW decode, no codec,
 * no `createImageBitmap`. It walks the GIF's block list by *sub-block length*
 * (advancing past each data block in O(number-of-sub-blocks), not
 * O(file size)), so it is milliseconds even for a multi-MB GIF and runs on the
 * main thread on upload without blocking. WebP walks the RIFF chunks counting
 * `ANMF` frames; APNG stops at a single `acTL` chunk. The actual per-frame
 * decode happens later, in the worker (#18 GIF, #26 WebP); here we only count.
 */
import type { ImageFormat } from "./types";

/**
 * The result of an animation scan.
 *
 * `isAnimated` is true when the file is a multi-frame container the pipeline
 * routes to {@link processAnimated} — animated GIF (v2) and animated WebP (v3,
 * issue #26). A single-frame file or one whose header we could not parse lands
 * as a still (`isAnimated: false`), routing to {@link processImage}.
 *
 * `apng` is a detection-only flag: when true the file *is* multi-frame, but v3
 * still treats it as a still (APNG encode lands in #27). The UI surfaces this as
 * an honest notice (PRD user story #19/#20) rather than silently degrading.
 */
export interface AnimationScan {
  /**
   * True for a multi-frame container the pipeline animates — GIF (v2) or WebP
   * (v3, issue #26). APNG stays detection-only until #27.
   */
  readonly isAnimated: boolean;
  /**
   * The number of frames detected, or 0 when not animated / uncountable. For a
   * multi-frame GIF this is the count of image descriptors; for an animated
   * WebP the count of `ANMF` chunks — in both cases the exact number the
   * per-frame decode loop will process. Surfaced to the UI so the user
   * understands what "animated" means concretely (PRD story #17).
   */
  readonly frameCount: number;
  /**
   * True when a WebP file's "ANIM" chunk indicates animation. In v3 (issue #26)
   * this is always equal to {@link isAnimated} for WebP — the file is routed to
   * {@link processAnimated}. Retained as a distinct flag so callers can branch
   * on format without re-checking the resolved {@link ImageFormat}.
   */
  readonly animatedWebp: boolean;
  /**
   * True when a PNG file's `acTL` chunk indicates it is an APNG. Detection-only
   * — v3 processes the first frame; APNG encode lands in #27.
   */
  readonly apng: boolean;
}

/** A still (non-animated) scan result, reused for the common case. */
const STILL: AnimationScan = {
  isAnimated: false,
  frameCount: 0,
  animatedWebp: false,
  apng: false,
};

/**
 * Detect whether a file is an animated image, and (for GIF) count its frames.
 *
 * Cheap and synchronous — a header scan only, no decode. Returns a still
 * result for any format v2 does not animate (everything except multi-frame
 * GIF) and for any GIF whose header cannot be parsed (a loud-but-safe fallback:
 * better to route a malformed GIF to the still path than to crash the upload).
 *
 * @param buffer the file's raw bytes (any length; the scan reads only headers).
 * @param format the resolved {@link ImageFormat} (the caller already mapped the
 *   File's MIME/extension via `formatFromFile`).
 */
export function detectAnimation(
  buffer: ArrayBuffer,
  format: ImageFormat,
): AnimationScan {
  switch (format) {
    case "gif":
      return scanGif(buffer);
    case "webp":
      return scanWebp(buffer);
    case "png":
      return scanPngApng(buffer);
    case "jpeg":
    case "avif":
    case "heic":
      // These containers carry a single frame in v2's input matrix. AVIF's
      // animated variant exists but is out of scope (PRD §Out of scope); HEIC
      // is a still photo format. JPEG is inherently single-frame.
      return STILL;
  }
}

/* -------------------------------------------------------------------------- */
/* GIF                                                                         */
/* -------------------------------------------------------------------------- */

/** GIF89a / GIF87a signature ("GIF"). */
const GIF_MAGIC_0 = 0x47; // 'G'
const GIF_MAGIC_1 = 0x49; // 'I'
const GIF_MAGIC_2 = 0x46; // 'F'

/** Block introducers in the GIF stream. */
const GIF_IMAGE_DESCRIPTOR = 0x2c; // ',' — one per frame (the image data follows)
const GIF_EXTENSION = 0x21; // '!' — followed by a label byte
const GIF_TRAILER = 0x3b; // ';' — end of stream

/**
 * Scan a GIF's block stream and count the image descriptors. Each image
 * descriptor is exactly one frame, so the count is the frame count. A GIF
 * with more than one image descriptor is animated.
 *
 * The scan walks the Logical Screen Descriptor + Global Color Table, then
 * iterates blocks: image descriptors (counted), extensions (sub-blocks
 * skipped), until the trailer or end of buffer. It is a faithful-enough header
 * walk to count frames without `gifuct-js` — that heavier parse lands in #18
 * where it also resolves disposal/offset/transparency.
 */
function scanGif(buffer: ArrayBuffer): AnimationScan {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 13) return STILL;
  if (
    bytes[0] !== GIF_MAGIC_0 ||
    bytes[1] !== GIF_MAGIC_1 ||
    bytes[2] !== GIF_MAGIC_2
  ) {
    // Not actually a GIF despite the format hint — fall back to still.
    return STILL;
  }

  // Logical Screen Descriptor: 7 bytes after the 6-byte signature/version.
  //   width(2) height(2) packed(1) bgColorIndex(1) pixelAspectRatio(1)
  // The packed byte's high bit tells whether a Global Color Table follows, and
  // its low 3 bits give the table size as 2^(N+1) entries of 3 bytes each.
  const packed = bytes[10];
  const hasGct = (packed & 0x80) !== 0;
  let pos = 13; // past signature(6) + LSD(7)
  if (hasGct) {
    const gctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += gctSize;
  }

  let frameCount = 0;
  // Guard against malformed streams: cap the walk at the buffer length and at
  // a sane iteration ceiling so a corrupt header can't spin. Real GIFs top out
  // in the low-hundreds of frames; 100k blocks is far beyond any real file.
  const maxIter = 100_000;
  let iter = 0;
  while (pos < bytes.length && iter++ < maxIter) {
    const introducer = bytes[pos];
    if (introducer === GIF_TRAILER) break; // ';' — clean end of stream

    if (introducer === GIF_IMAGE_DESCRIPTOR) {
      // Image Descriptor: 10 bytes (introducer + left/top/width/height + packed).
      // Skip the Local Color Table that may follow, then the image data sub-blocks.
      frameCount++;
      pos = skipImageDescriptor(bytes, pos);
      continue;
    }

    if (introducer === GIF_EXTENSION) {
      pos = skipExtension(bytes, pos);
      continue;
    }

    // Unknown introducer — the stream is malformed. Bail to the still path
    // rather than risk miscounting; a malformed GIF is not routed as animated.
    return STILL;
  }

  if (frameCount <= 1) return STILL;
  return { isAnimated: true, frameCount, animatedWebp: false, apng: false };
}

/**
 * Skip an Image Descriptor block (introducer `0x2C`): the 10-byte descriptor, an
 * optional Local Color Table, then LZW image data as a sequence of sub-blocks
 * (each a length byte + that many bytes), terminated by a zero-length byte.
 * Returns the position just past the block (the next introducer).
 */
function skipImageDescriptor(bytes: Uint8Array, start: number): number {
  let pos = start + 1; // past introducer
  if (pos + 9 > bytes.length) return bytes.length; // truncated descriptor
  const packed = bytes[pos + 8]; // descriptor's packed byte (10th byte from start)
  pos += 9; // past left(2)+top(2)+width(2)+height(2)+packed(1)
  const hasLct = (packed & 0x80) !== 0;
  if (hasLct) {
    const lctSize = 3 * (1 << ((packed & 0x07) + 1));
    pos += lctSize;
  }
  // Image data: an LZW minimum-code-size byte, THEN sub-blocks until a 0x00
  // marker. The min-code-size byte is a single byte (not a sub-block); skipping
  // it first is what keeps `skipSubBlocks` from misreading it as a length.
  if (pos < bytes.length) pos += 1; // LZW minimum code size
  pos = skipSubBlocks(bytes, pos);
  return pos;
}

/**
 * Skip an Extension block (introducer `0x21`): a label byte, then sub-blocks
 * until a 0x00 marker. Returns the position just past the block.
 */
function skipExtension(bytes: Uint8Array, start: number): number {
  let pos = start + 2; // past introducer + label
  pos = skipSubBlocks(bytes, pos);
  return pos;
}

/**
 * Skip a sequence of sub-blocks: each is a length byte followed by that many
 * bytes; a length of 0 terminates the sequence. Returns the position just past
 * the terminating 0x00 (i.e. the next top-level introducer).
 */
function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let pos = start;
  const maxIter = 1_000_000; // guard against a corrupt length-byte spin
  let iter = 0;
  while (pos < bytes.length && iter++ < maxIter) {
    const len = bytes[pos];
    pos += 1;
    if (len === 0) break; // terminator
    pos += len;
    if (pos > bytes.length) return bytes.length; // truncated sub-block
  }
  return pos;
}

/* -------------------------------------------------------------------------- */
/* WebP (ANIM chunk)                                                           */
/* -------------------------------------------------------------------------- */

/** "RIFF" / "WEBP" four-ccs. */
const RIFF_0 = 0x52; // 'R'
const RIFF_1 = 0x49; // 'I'
const RIFF_2 = 0x46; // 'F'
const RIFF_3 = 0x46; // 'F'
const WEBP_0 = 0x57; // 'W'
const WEBP_1 = 0x45; // 'E'
const WEBP_2 = 0x42; // 'B'
const WEBP_3 = 0x50; // 'P'

/**
 * Scan a WebP file's RIFF chunks for an "ANIM" chunk, which marks an animated
 * WebP. Detection-only — v2 still treats it as a still (PRD §Out of scope). The
 * frame count is not extracted (irrelevant: we won't process frames either way);
 * we only need the boolean to show the honest "treated as a still in v2" notice.
 */
function scanWebp(buffer: ArrayBuffer): AnimationScan {
  const bytes = new Uint8Array(buffer);
  // RIFF header: "RIFF" + size(4) + "WEBP" = 12 bytes minimum.
  if (bytes.length < 12) return STILL;
  if (
    bytes[0] !== RIFF_0 ||
    bytes[1] !== RIFF_1 ||
    bytes[2] !== RIFF_2 ||
    bytes[3] !== RIFF_3 ||
    bytes[8] !== WEBP_0 ||
    bytes[9] !== WEBP_1 ||
    bytes[10] !== WEBP_2 ||
    bytes[11] !== WEBP_3
  ) {
    return STILL;
  }
  // Walk the chunk list: each chunk is FourCC(4) + size(4 little-endian) + data.
  // Odd-sized chunks are padded by a trailing byte. The "ANIM" chunk is the
  // animation header — its mere presence means animated; each "ANMF" chunk is
  // one frame (issue #26 routes animated WebP to processAnimated, so the frame
  // count is now extracted and surfaced, mirroring the GIF scan).
  let pos = 12;
  let animated = false;
  let frameCount = 0;
  while (pos + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[pos],
      bytes[pos + 1],
      bytes[pos + 2],
      bytes[pos + 3],
    );
    const size =
      bytes[pos + 4] |
      (bytes[pos + 5] << 8) |
      (bytes[pos + 6] << 16) |
      (bytes[pos + 7] >>> 0) * 0x1000000;
    pos += 8;
    if (fourcc === "ANIM") {
      animated = true;
    } else if (fourcc === "ANMF") {
      frameCount++;
    }
    // Advance past the chunk data (+1 pad byte for odd sizes, per RIFF).
    pos += size + (size % 2);
  }
  if (!animated) return STILL;
  // A frame count below 2 means a malformed animation header with no ANMF
  // frames; treat it as a still rather than hand processAnimated zero frames.
  if (frameCount < 2) return STILL;
  return {
    isAnimated: true,
    frameCount,
    animatedWebp: true,
    apng: false,
  };
}

/* -------------------------------------------------------------------------- */
/* PNG / APNG (acTL chunk)                                                      */
/* -------------------------------------------------------------------------- */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Scan a PNG file's chunks for an `acTL` (animation control) chunk, which
 * marks an APNG. Detection-only — v2 still treats it as a still (PRD §Out of
 * scope). As with WebP, only the boolean is needed for the honest notice.
 */
function scanPngApng(buffer: ArrayBuffer): AnimationScan {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 8) return STILL;
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) return STILL;
  }
  // Walk chunks: length(4 BE) + type(4) + data + crc(4).
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len =
      ((bytes[pos] << 24) |
        (bytes[pos + 1] << 16) |
        (bytes[pos + 2] << 8) |
        bytes[pos + 3]) >>>
      0;
    const type = String.fromCharCode(
      bytes[pos + 4],
      bytes[pos + 5],
      bytes[pos + 6],
      bytes[pos + 7],
    );
    pos += 8;
    if (type === "acTL") {
      return { isAnimated: false, frameCount: 0, animatedWebp: false, apng: true };
    }
    pos += len + 4; // data + CRC
  }
  return STILL;
}

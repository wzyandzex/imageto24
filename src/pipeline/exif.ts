/**
 * JPEG segment parsing / EXIF copying — pure, environment-free.
 *
 * The browser Canvas encoder strips all metadata on re-encode. To honour the
 * "EXIF preserved by default" rule (PRD / issue #4), the faithful pipeline keeps
 * the *source* file's bytes around and re-attaches its EXIF APP1 segment to the
 * re-encoded output. This module does the segment-level surgery: it is pure byte
 * manipulation with no Canvas, no globals, so it is fully testable in Node.
 *
 * Only JPEG carries EXIF in an APP1 segment in the format most cameras emit, so
 * EXIF handling is scoped to JPEG here. PNG/WebP/AVIF from Canvas carry no EXIF
 * regardless, which already satisfies "preserve by default" for those outputs
 * (there is nothing to preserve). Stripping always succeeds trivially.
 */

/** Standard JPEG markers we care about. */
const SOI = 0xd8; // Start of image
const SOS = 0xda; // Start of scan (image data follows)
const APP1 = 0xe1; // Application segment 1 (EXIF or XMP)

/** Read a big-endian uint16 at an offset. */
function readUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, false);
}

/** A parsed JPEG segment (marker + body), excluding SOI/SOS payloads. */
export interface JpegSegment {
  readonly marker: number;
  /** Offset of the marker byte in the source buffer. */
  readonly offset: number;
  /** Offset of the segment body (length + payload), immediately after marker. */
  readonly bodyOffset: number;
  /** Total byte length of the segment including marker and length field. */
  readonly length: number;
}

/**
 * Is this APP1 segment an EXIF segment? EXIF APP1 starts with "Exif\0\0".
 */
export function isExifApp1(segment: JpegSegment, view: DataView): boolean {
  if (segment.marker !== APP1) return false;
  // Body layout: [2-byte length][ "Exif" 4 ][ 0x00 0x00 ][ TIFF ... ]
  // The "Exif\0\0" header sits at bodyOffset + 2.
  const idOffset = segment.bodyOffset + 2;
  if (idOffset + 6 > view.byteLength) return false;
  return (
    view.getUint8(idOffset) === 0x45 && // E
    view.getUint8(idOffset + 1) === 0x78 && // x
    view.getUint8(idOffset + 2) === 0x69 && // i
    view.getUint8(idOffset + 3) === 0x66 && // f
    view.getUint8(idOffset + 4) === 0x00 &&
    view.getUint8(idOffset + 5) === 0x00
  );
}

/**
 * Enumerate the leading JPEG segments up to (and including) the SOS marker.
 *
 * JPEG is a sequence of segments: [FF marker][2-byte length, incl. itself][payload].
 * SOI has no length; SOS is followed by entropy-coded data we treat as opaque.
 * Returns segments in order. Throws if the buffer is not a JPEG.
 */
export function parseJpegSegments(buffer: ArrayBuffer): JpegSegment[] {
  const view = new DataView(buffer);
  if (view.byteLength < 2 || view.getUint8(0) !== 0xff || view.getUint8(1) !== SOI) {
    throw new Error("Not a JPEG: missing SOI marker");
  }

  const segments: JpegSegment[] = [];
  let offset = 2; // skip SOI
  while (offset + 1 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) {
      throw new Error(`Expected marker prefix 0xFF at offset ${offset}`);
    }
    let marker = view.getUint8(offset + 1);
    // Skip fill bytes (0xFF padding) — marker 0xFF is not a real segment.
    while (marker === 0xff && offset + 2 < view.byteLength) {
      offset += 1;
      marker = view.getUint8(offset + 1);
    }

    // SOI (0xD8), EOI (0xD9) and RSTn (0xD0-0xD7) are standalone markers with no
    // length field. 0x00 is an escaped 0xFF inside entropy data (not reached
    // before SOS). We stop at SOS (image data follows) and EOI (end of image).
    if (marker === SOS || marker === 0xd9 /* EOI */) {
      segments.push({ marker, offset, bodyOffset: offset + 2, length: 2 });
      break;
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const bodyOffset = offset + 2;
    if (bodyOffset + 2 > view.byteLength) {
      throw new Error(`Truncated segment length at offset ${bodyOffset}`);
    }
    const segLen = readUint16(view, bodyOffset); // includes the 2 length bytes
    const totalLen = 2 + segLen; // marker (2) + body (segLen)
    segments.push({ marker, offset, bodyOffset, length: totalLen });
    offset += totalLen;
  }
  return segments;
}

/** Extract the raw EXIF APP1 segment bytes from a JPEG, if present. */
export function extractExifSegment(buffer: ArrayBuffer): Uint8Array | undefined {
  const view = new DataView(buffer);
  const segments = parseJpegSegments(buffer);
  for (const seg of segments) {
    if (isExifApp1(seg, view)) {
      return new Uint8Array(buffer, seg.offset, seg.length);
    }
  }
  return undefined;
}

/**
 * Build an output JPEG by taking the (Canvas-re-encoded) `output` bytes and
 * injecting the `exif` APP1 segment right after the SOI marker. Returns the
 * output unchanged when there is no EXIF to inject.
 *
 * Pure: allocates and returns a new buffer; never mutates inputs.
 */
export function injectExifIntoJpeg(output: ArrayBuffer, exif: Uint8Array | undefined): ArrayBuffer {
  if (!exif || exif.length === 0) return output;
  const outView = new DataView(output);
  // Confirm the re-encoded output is a JPEG (SOI at 0).
  if (outView.byteLength < 2 || outView.getUint8(0) !== 0xff || outView.getUint8(1) !== SOI) {
    return output;
  }
  const head = 2; // SOI
  const result = new Uint8Array(output.byteLength - head + head + exif.length);
  // SOI ...
  result.set(new Uint8Array(output, 0, head), 0);
  // ... EXIF APP1 ...
  result.set(exif, head);
  // ... rest of the encoded JPEG.
  result.set(new Uint8Array(output, head), head + exif.length);
  return result.buffer;
}

/**
 * High-level helper used by the encoder: given the original source file and the
 * freshly-encoded output, return the output with EXIF preserved or stripped per
 * the option. Non-JPEG sources/outputs are returned unchanged (nothing to do).
 */
export function applyExifOption(
  source: ArrayBuffer | undefined,
  output: ArrayBuffer,
  preserveExif: boolean,
  outputIsJpeg: boolean,
): ArrayBuffer {
  if (!outputIsJpeg) return output;
  if (!preserveExif) return output; // Canvas already stripped it; nothing to add.
  if (!source) return output;
  const exif = extractExifSegment(source);
  return injectExifIntoJpeg(output, exif);
}

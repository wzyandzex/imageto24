/**
 * Pure APNG chunk parser + compositor (issue #37).
 *
 * This module owns APNG container semantics only: chunk walking, fcTL/fdAT frame
 * reconstruction, delay conversion, blend, and disposal. The actual PNG bitmap
 * decode is injected so tests can exercise the parser without a browser or
 * pngjs; the browser codec wires it to pngjs lazily for the fallback path.
 */
import type { DecodedAnimatedFrame, ImageData } from "../types";

export type PngFrameDecoder = (png: ArrayBuffer) => Promise<ImageData>;

type ApngBlendOp = 0 | 1;
type ApngDisposeOp = 0 | 1 | 2;

interface PngChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

interface FrameControl {
  readonly width: number;
  readonly height: number;
  readonly xOffset: number;
  readonly yOffset: number;
  readonly delay: number;
  readonly disposeOp: ApngDisposeOp;
  readonly blendOp: ApngBlendOp;
}

interface RawFrame {
  readonly control: FrameControl;
  readonly imageParts: Uint8Array[];
}

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const PNG_IEND = new Uint8Array([
  0x00, 0x00, 0x00, 0x00,
  0x49, 0x45, 0x4e, 0x44,
  0xae, 0x42, 0x60, 0x82,
]);

/** Decode an APNG into full-canvas composited frames. */
export async function decodeApngFrames(
  buffer: ArrayBuffer,
  decodePng: PngFrameDecoder,
): Promise<DecodedAnimatedFrame[]> {
  const parsed = parseApng(buffer);
  const canvas = new Uint8ClampedArray(parsed.width * parsed.height * 4);
  const decoded: DecodedAnimatedFrame[] = [];

  for (const frame of parsed.frames) {
    if (frame.imageParts.length === 0) {
      throw new Error("APNG decode: frame had no image data");
    }

    const beforeFrame = new Uint8ClampedArray(canvas);
    const png = buildFramePng(parsed, frame);
    const patch = await decodePng(png);
    if (
      patch.width !== frame.control.width ||
      patch.height !== frame.control.height
    ) {
      throw new Error("APNG decode: decoded frame dimensions did not match fcTL");
    }

    compositePatch(canvas, parsed.width, frame.control, patch.data);
    decoded.push({
      imageData: {
        width: parsed.width,
        height: parsed.height,
        data: new Uint8ClampedArray(canvas),
      },
      delay: frame.control.delay,
      // GIF encoders understand 0/1/2/3; APNG dispose previous is analogous to 3.
      disposalType: frame.control.disposeOp === 2 ? 3 : frame.control.disposeOp,
    });

    applyDisposal(canvas, parsed.width, frame.control, beforeFrame);
  }

  if (decoded.length === 0) {
    throw new Error("APNG decode: no decodable frames");
  }
  return decoded;
}

interface ParsedApng {
  readonly width: number;
  readonly height: number;
  readonly preIdatChunks: PngChunk[];
  readonly frames: RawFrame[];
}

function parseApng(buffer: ArrayBuffer): ParsedApng {
  const bytes = new Uint8Array(buffer);
  assertPngSignature(bytes);

  let pos = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let sawActl = false;
  let expectedFrames = 0;
  let sawIdat = false;
  const preIdatChunks: PngChunk[] = [];
  const frames: RawFrame[] = [];
  let current: { control: FrameControl; imageParts: Uint8Array[] } | undefined;

  while (pos + 12 <= bytes.length) {
    const length = readU32(bytes, pos);
    const type = ascii(bytes, pos + 4, 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (dataEnd > bytes.length || next > bytes.length) {
      throw new Error("APNG decode: truncated PNG chunk");
    }
    const data = bytes.slice(dataStart, dataEnd);

    switch (type) {
      case "IHDR":
        if (length !== 13) throw new Error("APNG decode: invalid IHDR chunk");
        width = readU32(data, 0);
        height = readU32(data, 4);
        preIdatChunks.push({ type, data });
        break;
      case "acTL":
        if (length !== 8) throw new Error("APNG decode: invalid acTL chunk");
        sawActl = true;
        expectedFrames = readU32(data, 0);
        break;
      case "fcTL": {
        if (length !== 26) throw new Error("APNG decode: invalid fcTL chunk");
        if (current) frames.push(current);
        current = { control: parseFrameControl(data), imageParts: [] };
        break;
      }
      case "fdAT":
        if (!current) throw new Error("APNG decode: fdAT before fcTL");
        if (length < 4) throw new Error("APNG decode: invalid fdAT chunk");
        current.imageParts.push(data.slice(4)); // first 4 bytes are sequence_number
        break;
      case "IDAT":
        sawIdat = true;
        if (!current) {
          // Some APNGs omit the first fcTL and use the default image as a poster.
          // That poster is not part of the animation frames; ignore it here.
          break;
        }
        current.imageParts.push(data);
        break;
      case "IEND":
        pos = bytes.length;
        continue;
      default:
        if (!sawIdat && shouldCopyIntoFramePng(type)) {
          preIdatChunks.push({ type, data });
        }
        break;
    }

    pos = next;
  }

  if (current) frames.push(current);
  if (!width || !height) throw new Error("APNG decode: missing IHDR chunk");
  if (!sawActl) throw new Error("APNG decode: missing acTL chunk");
  if (expectedFrames < 1) throw new Error("APNG decode: acTL reported no frames");
  if (frames.length < 1) throw new Error("APNG decode: no fcTL frames found");

  return { width, height, preIdatChunks, frames };
}

function parseFrameControl(data: Uint8Array): FrameControl {
  const width = readU32(data, 4);
  const height = readU32(data, 8);
  const xOffset = readU32(data, 12);
  const yOffset = readU32(data, 16);
  const delayNum = readU16(data, 20);
  const delayDen = readU16(data, 22) || 100;
  const disposeOp = data[24];
  const blendOp = data[25];
  if (width < 1 || height < 1) throw new Error("APNG decode: invalid frame dimensions");
  if (disposeOp > 2) throw new Error("APNG decode: invalid APNG dispose op");
  if (blendOp > 1) throw new Error("APNG decode: invalid APNG blend op");
  return {
    width,
    height,
    xOffset,
    yOffset,
    delay: Math.max(1, Math.round((delayNum / delayDen) * 1000)) || 100,
    disposeOp: disposeOp as ApngDisposeOp,
    blendOp: blendOp as ApngBlendOp,
  };
}

function buildFramePng(parsed: ParsedApng, frame: RawFrame): ArrayBuffer {
  const chunks: Uint8Array[] = [PNG_SIGNATURE];
  for (const chunk of parsed.preIdatChunks) {
    if (chunk.type === "IHDR") {
      const ihdr = new Uint8Array(chunk.data);
      writeU32(ihdr, 0, frame.control.width);
      writeU32(ihdr, 4, frame.control.height);
      chunks.push(writeChunk("IHDR", ihdr));
    } else {
      chunks.push(writeChunk(chunk.type, chunk.data));
    }
  }
  for (const part of frame.imageParts) {
    chunks.push(writeChunk("IDAT", part));
  }
  chunks.push(PNG_IEND);
  return concat(chunks).buffer;
}

function compositePatch(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  control: FrameControl,
  patch: Uint8ClampedArray,
): void {
  for (let y = 0; y < control.height; y++) {
    for (let x = 0; x < control.width; x++) {
      const src = (y * control.width + x) * 4;
      const dst = ((control.yOffset + y) * canvasWidth + control.xOffset + x) * 4;
      if (control.blendOp === 0) {
        canvas[dst] = patch[src];
        canvas[dst + 1] = patch[src + 1];
        canvas[dst + 2] = patch[src + 2];
        canvas[dst + 3] = patch[src + 3];
      } else {
        alphaOver(canvas, dst, patch, src);
      }
    }
  }
}

function alphaOver(
  dstBuf: Uint8ClampedArray,
  dst: number,
  srcBuf: Uint8ClampedArray,
  src: number,
): void {
  const sa = srcBuf[src + 3] / 255;
  if (sa === 0) return;
  if (sa === 1 || dstBuf[dst + 3] === 0) {
    dstBuf[dst] = srcBuf[src];
    dstBuf[dst + 1] = srcBuf[src + 1];
    dstBuf[dst + 2] = srcBuf[src + 2];
    dstBuf[dst + 3] = srcBuf[src + 3];
    return;
  }
  const da = dstBuf[dst + 3] / 255;
  const outA = sa + da * (1 - sa);
  dstBuf[dst] = Math.round((srcBuf[src] * sa + dstBuf[dst] * da * (1 - sa)) / outA);
  dstBuf[dst + 1] = Math.round((srcBuf[src + 1] * sa + dstBuf[dst + 1] * da * (1 - sa)) / outA);
  dstBuf[dst + 2] = Math.round((srcBuf[src + 2] * sa + dstBuf[dst + 2] * da * (1 - sa)) / outA);
  dstBuf[dst + 3] = Math.round(outA * 255);
}

function applyDisposal(
  canvas: Uint8ClampedArray,
  canvasWidth: number,
  control: FrameControl,
  beforeFrame: Uint8ClampedArray,
): void {
  if (control.disposeOp === 1) {
    for (let y = 0; y < control.height; y++) {
      const start = ((control.yOffset + y) * canvasWidth + control.xOffset) * 4;
      canvas.fill(0, start, start + control.width * 4);
    }
  } else if (control.disposeOp === 2) {
    canvas.set(beforeFrame);
  }
}

function shouldCopyIntoFramePng(type: string): boolean {
  // Copy PNG chunks that are valid before IDAT and relevant to decoding the frame.
  // Exclude APNG control chunks and IDAT/IEND; fdAT becomes IDAT separately.
  return !["acTL", "fcTL", "fdAT", "IDAT", "IEND"].includes(type);
}

function assertPngSignature(bytes: Uint8Array): void {
  if (bytes.length < PNG_SIGNATURE.length) throw new Error("APNG decode: invalid PNG signature");
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error("APNG decode: invalid PNG signature");
  }
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function writeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  writeU32(out, 8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  return out;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

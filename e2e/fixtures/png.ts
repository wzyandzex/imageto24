/**
 * Shared PNG test fixtures for the Playwright e2e suite.
 *
 * Several e2e specs need a valid PNG of known dimensions, generated at runtime
 * so the suite stays self-contained with no committed binary assets. Extracted
 * here to avoid a third copy of the CRC32 / chunk-building boilerplate.
 */
import { deflateSync } from "node:zlib";

/** CRC32 for PNG chunk checksums (PNG uses the IEEE polynomial). */
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

/** Build a PNG chunk: length(4) + type(4) + data + crc(4). */
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Build a solid-colour RGBA PNG of the given dimensions. The pixel colour is
 * deterministic so faithful-mode output assertions stay stable across runs.
 */
export function makePng(width: number, height: number, r = 200, g = 120, b = 60): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data: each scanline prefixed with filter byte 0.
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter: none
    for (let x = 0; x < rowLen; x += 4) {
      const base = y * (rowLen + 1) + 1 + x;
      raw[base] = r;
      raw[base + 1] = g;
      raw[base + 2] = b;
      raw[base + 3] = 255; // A
    }
  }
  const idat = deflateSync(raw);

  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Parse the PNG IHDR to read width/height from a downloaded buffer. */
export function readPngDims(buf: Buffer): { width: number; height: number } {
  // IHDR follows the 8-byte signature: length(4) + "IHDR"(4) + data.
  const ihdrDataStart = 8 + 4 + 4;
  return {
    width: buf.readUInt32BE(ihdrDataStart),
    height: buf.readUInt32BE(ihdrDataStart + 4),
  };
}

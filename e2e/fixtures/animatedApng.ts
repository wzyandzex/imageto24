import { deflateSync } from "node:zlib";

/** CRC32 for PNG/APNG chunk checksums (IEEE polynomial). */
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

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function frameControl(
  sequence: number,
  width: number,
  height: number,
  delayMs: number,
): Buffer {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(width, 4);
  data.writeUInt32BE(height, 8);
  data.writeUInt32BE(0, 12); // x_offset
  data.writeUInt32BE(0, 16); // y_offset
  data.writeUInt16BE(delayMs, 20);
  data.writeUInt16BE(1000, 22);
  data[24] = 0; // APNG_DISPOSE_OP_NONE
  data[25] = 0; // APNG_BLEND_OP_SOURCE
  return chunk("fcTL", data);
}

function frameData(sequence: number, idat: Buffer): Buffer {
  const data = Buffer.alloc(4 + idat.length);
  data.writeUInt32BE(sequence, 0);
  idat.copy(data, 4);
  return chunk("fdAT", data);
}

function rgbaFrame(width: number, height: number, frameIndex: number): Buffer {
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // PNG filter: none
    for (let x = 0; x < width; x++) {
      const base = y * (rowLen + 1) + 1 + x * 4;
      raw[base] = (x * 13 + frameIndex * 50) & 0xff;
      raw[base + 1] = (y * 17 + frameIndex * 30) & 0xff;
      raw[base + 2] = ((x + y) * 9 + frameIndex * 20) & 0xff;
      raw[base + 3] = x < 2 && y < 2 ? 128 : 255;
    }
  }
  return deflateSync(raw);
}

/**
 * Build a real 3-frame APNG fixture for #39's tracer-bullet e2e.
 *
 * Full-canvas RGBA frames keep decoder semantics simple while still proving APNG
 * detection/routing, timing, alpha-capable true-colour output, and APNG re-encode.
 */
export function makeAnimatedApng(width = 16, height = 16): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(3, 0);
  actl.writeUInt32BE(0, 4); // loop forever

  const idat0 = rgbaFrame(width, height, 0);
  const idat1 = rgbaFrame(width, height, 1);
  const idat2 = rgbaFrame(width, height, 2);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("acTL", actl),
    frameControl(0, width, height, 100),
    chunk("IDAT", idat0),
    frameControl(1, width, height, 150),
    frameData(2, idat1),
    frameControl(3, width, height, 200),
    frameData(4, idat2),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

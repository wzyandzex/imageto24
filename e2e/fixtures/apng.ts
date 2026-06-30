/**
 * APNG test fixtures + a minimal chunk parser for the Playwright e2e suite
 * (issue #27). The e2e downloads the APNG the worker produced and re-decodes it
 * here to assert the round-trip survived: it is a *valid animated* PNG (carries
 * an `acTL` chunk), with the expected frame count, canvas dimensions, and that
 * it is *true-colour* (PNG colour type 6 = RGBA 8-bit, the fidelity win over
 * GIF's 256-colour ceiling).
 *
 * This is a header walk only — no inflate, no pixel decode — mirroring
 * `animatedDetect.ts`'s philosophy of reading container structure, not pixels.
 * It is enough to prove the APNG is well-formed and animated at the claimed
 * resolution; the pixel truth is covered by the Vitest codec contract tests.
 */

/** CRC32 (IEEE) — reused to validate chunk integrity if needed. */
function crc32(buf: Uint8Array): number {
  let table: number[] | undefined = (crc32 as unknown as { table?: number[] })
    .table;
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

/** The parsed structure of a well-formed APNG, as far as the e2e needs it. */
export interface ApngStructure {
  /** IHDR width. */
  readonly width: number;
  /** IHDR height. */
  readonly height: number;
  /**
   * PNG colour type from the IHDR. 6 ⇒ true-colour RGBA (8-bit/channel) — the
   * colour-fidelity outcome #27 targets (no palette, no quantization). 2 ⇒
   * true-colour RGB (no alpha); 3 ⇒ palette (would indicate quantization).
   */
  readonly colourType: number;
  /** True when an `acTL` chunk is present (i.e. the file is genuinely animated). */
  readonly animated: boolean;
  /** `acTL.num_frames` — the frame count the animation carries. */
  readonly frameCount: number;
  /** `acTL.num_plays` — 0 ⇒ loop forever. */
  readonly numPlays: number;
  /**
   * Per-frame delays in milliseconds, in frame order, from the `fcTL` chunks
   * (delay_num / delay_den × 1000). UPNG writes den=1000, so num is already ms.
   */
  readonly delays: number[];
  /** True if every chunk's CRC matches its computed checksum. */
  readonly crcsValid: boolean;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Walk the PNG/APNG chunk list and surface the structure the e2e asserts on.
 * Throws if the signature is not a PNG or a chunk runs past the buffer.
 */
export function parseApng(buf: Uint8Array): ApngStructure {
  if (buf.length < 8) throw new Error("not a PNG: too short");
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (buf[i] !== PNG_SIG[i]) throw new Error("not a PNG: bad signature");
  }

  let width = 0;
  let height = 0;
  let colourType = 0;
  let animated = false;
  let frameCount = 0;
  let numPlays = 0;
  const delays: number[] = [];
  let crcsValid = true;

  let pos = 8;
  while (pos + 8 <= buf.length) {
    const len =
      ((buf[pos] << 24) |
        (buf[pos + 1] << 16) |
        (buf[pos + 2] << 8) |
        buf[pos + 3]) >>>
      0;
    const type = String.fromCharCode(
      buf[pos + 4],
      buf[pos + 5],
      buf[pos + 6],
      buf[pos + 7],
    );
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new Error(`chunk ${type} runs past EOF`);

    // Validate CRC (length covers type + data; CRC is the 4 bytes after data).
    const crcStored =
      ((buf[dataEnd] << 24) |
        (buf[dataEnd + 1] << 16) |
        (buf[dataEnd + 2] << 8) |
        buf[dataEnd + 3]) >>>
      0;
    const crcCalc = crc32(buf.subarray(dataStart - 4, dataEnd));
    if (crcStored !== crcCalc) crcsValid = false;

    if (type === "IHDR") {
      width = (buf[dataStart] << 24) | (buf[dataStart + 1] << 16) |
        (buf[dataStart + 2] << 8) | buf[dataStart + 3];
      height = (buf[dataStart + 4] << 24) | (buf[dataStart + 5] << 16) |
        (buf[dataStart + 6] << 8) | buf[dataStart + 7];
      colourType = buf[dataStart + 9];
    } else if (type === "acTL") {
      animated = true;
      frameCount =
        (buf[dataStart] << 24) | (buf[dataStart + 1] << 16) |
        (buf[dataStart + 2] << 8) | buf[dataStart + 3];
      numPlays =
        (buf[dataStart + 4] << 24) | (buf[dataStart + 5] << 16) |
        (buf[dataStart + 6] << 8) | buf[dataStart + 7];
    } else if (type === "fcTL") {
      // delay_num (2 BE) at offset 20, delay_den (2 BE) at offset 22 within the
      // fcTL data (after sequence_number(4) + width(4) + height(4) + x_offset(4)
      // + y_offset(4)). delay = num/den seconds → ms.
      const delayNum = (buf[dataStart + 20] << 8) | buf[dataStart + 21];
      const delayDen = (buf[dataStart + 22] << 8) | buf[dataStart + 23] || 100;
      delays.push(Math.round((delayNum / delayDen) * 1000));
    }

    pos = dataEnd + 4; // past data + CRC
    if (type === "IEND") break;
  }

  return {
    width,
    height,
    colourType,
    animated,
    frameCount,
    numPlays,
    delays,
    crcsValid,
  };
}

import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * E2E for issue #5: when capability is mocked unsupported (no WebGPU), the AI
 * option is visibly disabled with an honest explanation, while Faithful remains
 * offered as the selected universal fallback.
 */

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

/** Build a solid-colour RGBA PNG of the given dimensions. */
function makePng(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0;
    for (let x = 0; x < rowLen; x += 4) {
      const base = y * (rowLen + 1) + 1 + x;
      raw[base] = 120;
      raw[base + 1] = 140;
      raw[base + 2] = 180;
      raw[base + 3] = 255;
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

test("device capability: unsupported WebGPU disables AI and offers Faithful", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-capability-e2e-"));
  const srcPath = join(dir, "source.png");
  writeFileSync(srcPath, makePng(320, 180));

  await page.addInitScript(() => {
    // Mock WebGPU as unsupported before the app's capability probe runs.
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => undefined,
    });
  });

  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(srcPath);

  const faithful = page.getByTestId("mode-faithful");
  const ai = page.getByTestId("mode-ai");

  await expect(faithful).toBeVisible();
  await expect(faithful).toHaveAttribute("aria-selected", "true");
  await expect(faithful).toContainText("Faithful");
  await expect(faithful).toContainText("Mathematically lossless");

  await expect(ai).toBeVisible();
  await expect(ai).toHaveAttribute("aria-disabled", "true");
  await expect(ai).toContainText("AI Enhance");
  await expect(ai).toContainText("needs WebGPU");
});

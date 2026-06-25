import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/**
 * E2E tracer bullet for faithful mode (issue #4):
 * upload → faithful → 4K → download, asserting the downloaded file is a valid
 * PNG at the expected 4K dimensions.
 *
 * The source fixture is a small PNG generated at runtime (320×180, long edge 320)
 * so the test is self-contained with no committed binary asset. At 4K the output
 * long edge must be 3840, aspect-ratio preserved (3840 × 2160).
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

  // Raw image data: each scanline prefixed with filter byte 0.
  const rowLen = width * 4;
  const raw = Buffer.alloc((rowLen + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (rowLen + 1)] = 0; // filter: none
    for (let x = 0; x < rowLen; x += 4) {
      const base = y * (rowLen + 1) + 1 + x;
      raw[base] = 200; // R
      raw[base + 1] = 120; // G
      raw[base + 2] = 60; // B
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
function readPngDims(buf: Buffer): { width: number; height: number } {
  // IHDR follows the 8-byte signature: length(4) + "IHDR"(4) + data.
  const ihdrDataStart = 8 + 4 + 4;
  return {
    width: buf.readUInt32BE(ihdrDataStart),
    height: buf.readUInt32BE(ihdrDataStart + 4),
  };
}

test("faithful mode: upload → 4K → download a valid PNG at 4K dimensions", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-e2e-"));
  const srcPath = join(dir, "source.png");
  const outPath = join(dir, "upscaled.png");
  // 320×180 source: long edge 320 → 4K long edge 3840 ⇒ output 3840×2160.
  writeFileSync(srcPath, makePng(320, 180));

  await page.goto("/");

  // Upload via the hidden file input (drag-drop is hard to drive reliably).
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(srcPath);

  // The preview and original dimensions appear.
  await expect(page.getByTestId("original-dimensions")).toContainText("320 × 180");
  await expect(page.getByTestId("source-preview")).toBeVisible();

  // Faithful is the active mode by default; ensure 4K is selected.
  await page.getByTestId("tier-4K").click();

  // Trigger the upscale. The run completes off the main thread.
  await page.getByTestId("upscale-button").click();
  // Wait for the result to be produced (download link renders once done).
  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 2160", { timeout: 180_000 });

  // Now click the download link and capture the resulting download.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);

  // Assert the downloaded file is a valid PNG at the expected 4K dimensions.
  const downloaded = readFileSync(outPath);
  // PNG signature check.
  expect(downloaded[0]).toBe(0x89);
  expect(downloaded[1]).toBe(0x50); // 'P'
  expect(downloaded[2]).toBe(0x4e); // 'N'
  expect(downloaded[3]).toBe(0x47); // 'G'
  const dims = readPngDims(downloaded);
  expect(dims.width).toBe(3840);
  expect(dims.height).toBe(2160);

  // Result dimensions text reflects the same.
  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 2160");
});

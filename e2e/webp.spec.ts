import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPngDims } from "./fixtures/png";

/**
 * E2E for static-WebP input (issue #26 context). A static WebP is NOT routed to
 * the animated path — `detectAnimation` finds no ANIM/ANMF chunks and reports a
 * still — so it flows through `processImage` like any other still (native
 * `createImageBitmap` decode in the worker → faithful Lanczos → PNG/WebP
 * encode). This pins that contract end-to-end with a real browser-decodable
 * WebP: it must not be mis-detected as animated, must upscale, and must produce
 * a valid non-WebP result at the 4K dimensions.
 *
 * (The animated-WebP *decode* path — WebCodecs `ImageDecoder` + the wasm
 * fallback — is covered by `animatedWebpCodec.test.ts` under Vitest. A full
 * browser-decodable *animated* WebP round-trip needs a real multi-frame bitstream
 * the standard surface can't encode; this static-WebP e2e is the real-input
 * proof for the still side, and the not-animated assertion guards the routing.)
 *
 * The fixture is a committed real static WebP (`sample.webp`, 1536×1024, long
 * edge 1536); a 4K faithful upscale lands at 3840×2560 (3:2 preserved).
 */
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.webp",
);

test("static WebP: not detected as animated → faithful → 4K → valid PNG (issue #26 routing)", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-webp-e2e-"));
  const outPath = join(dir, "upscaled.png");

  await page.goto("/");

  // Upload the real static WebP via the hidden single-image file input.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(FIXTURE);

  // Original dimensions render from the browser's native WebP decode (readDimensions
  // via <img>). 1536×1024.
  await expect(page.getByTestId("original-dimensions")).toContainText(
    "1536 × 1024",
  );
  await expect(page.getByTestId("source-preview")).toBeVisible();

  // Routing guard: a static WebP must NOT be detected as animated. None of the
  // animated notices render — it stays on the still path (processImage).
  await expect(page.getByTestId("animated-notice")).toHaveCount(0);
  await expect(page.getByTestId("animated-frame-count")).toHaveCount(0);
  await expect(page.getByTestId("animated-webp-notice")).toHaveCount(0);
  await expect(page.getByTestId("apng-notice")).toHaveCount(0);

  // Faithful is the default mode; select 4K. 1536 long edge → 4K (3840) ⇒ 3840×2560.
  await page.getByTestId("tier-4K").click();
  await page.getByTestId("upscale-button").click();

  // Wait for the result: the faithful 4K upscale of a 1536×1024 source lands at
  // 3840×2560 (aspect ratio preserved).
  await expect(page.getByTestId("result-dimensions")).toContainText(
    "3840 × 2560",
    { timeout: 180_000 },
  );

  // Download the result and capture it.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);

  // The downloaded file is a valid PNG at the 4K dimensions. PNG signature +
  // IHDR dims confirm both the format and the upscale.
  const downloaded = readFileSync(outPath);
  expect(downloaded[0]).toBe(0x89);
  expect(downloaded[1]).toBe(0x50); // 'P'
  expect(downloaded[2]).toBe(0x4e); // 'N'
  expect(downloaded[3]).toBe(0x47); // 'G'
  const dims = readPngDims(downloaded);
  expect(dims.width).toBe(3840);
  expect(dims.height).toBe(2560);
});

import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePng, readPngDims } from "./fixtures/png";

/**
 * E2E tracer bullet for faithful mode (issue #4):
 * upload → faithful → 4K → download, asserting the downloaded file is a valid
 * PNG at the expected 4K dimensions.
 *
 * The source fixture is a small PNG generated at runtime (320×180, long edge 320)
 * so the test is self-contained with no committed binary asset. At 4K the output
 * long edge must be 3840, aspect-ratio preserved (3840 × 2160).
 */

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

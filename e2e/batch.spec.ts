import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePng, readPngDims } from "./fixtures/png";

/**
 * E2E for issue #9: the batch queue.
 *
 * Upload multiple images, assert the overall progress indicator advances and
 * every result downloads. The batch queue runs serially (one image fully
 * processed at a time), but that guarantee is asserted at the unit layer; here
 * we assert the user-facing contract: progress moves, each item reaches "done",
 * and all results are downloadable.
 *
 * Sources are small runtime-generated PNGs (160×100, long edge 160). The batch
 * targets the 2K tier (2560 long edge) so each faithful-mode Lanczos upscale
 * stays fast enough for the suite while still exercising the real encode path.
 */

test("batch: upload multiple images, progress advances, all results download", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-batch-e2e-"));
  const names = ["alpha.png", "bravo.png", "charlie.png"];
  const srcPaths = names.map((n) => join(dir, n));
  // Distinct colours per file so they're not byte-identical.
  srcPaths.forEach((p, i) =>
    writeFileSync(p, makePng(160, 100, 200 - i * 40, 120 + i * 30, 60)),
  );

  // Capture every download the page fires; "Download all" triggers several.
  const downloads: string[] = [];
  page.on("download", async (d) => {
    const out = join(dir, `dl-${downloads.length}-${d.suggestedFilename()}`);
    await d.saveAs(out);
    downloads.push(out);
  });

  await page.goto("/");

  // Select the 2K tier — it's the shared control that drives the batch too.
  await page.getByTestId("tier-2K").click();

  // Pick the batch input (the multi-file picker lives in the BatchPanel).
  const batchInput = page.locator('input[type="file"][multiple]');
  await batchInput.setInputFiles(srcPaths);

  // All three items appear in the list, initially queued.
  const list = page.getByTestId("batch-list");
  await expect(list).toBeVisible();
  await expect(page.getByTestId("batch-item-alpha.png-0")).toBeVisible();
  await expect(page.getByTestId("batch-item-bravo.png-1")).toBeVisible();
  await expect(page.getByTestId("batch-item-charlie.png-2")).toBeVisible();

  // The progress text starts at 0 / 3.
  await expect(page.getByTestId("batch-progress-text")).toContainText("0 / 3");

  // Wait for the batch to complete (the overall bar fills and the summary
  // appears). 2K faithful Lanczos on 160px sources is well under the default
  // timeout per item; we allow generous headroom for CI.
  await expect(page.getByTestId("batch-summary")).toBeVisible({ timeout: 180_000 });
  await expect(page.getByTestId("batch-summary")).toContainText("3 of 3 done");

  // Every item reached "done".
  await expect(page.getByTestId("batch-status-alpha.png-0")).toHaveText("done");
  await expect(page.getByTestId("batch-status-bravo.png-1")).toHaveText("done");
  await expect(page.getByTestId("batch-status-charlie.png-2")).toHaveText("done");

  // Progress indicator advanced to 3 / 3.
  await expect(page.getByTestId("batch-progress-text")).toContainText("3 / 3");

  // Trigger "Download all" and wait for all three downloads to land.
  await page.getByTestId("batch-download-all").click();
  await expect.poll(() => downloads.length, { timeout: 30_000 }).toBe(3);

  // Every downloaded file is a valid PNG at the 2K target dimensions
  // (160-long-edge source × 16 = 2560, 100 × 16 = 1600).
  for (const out of downloads) {
    const buf = readFileSync(out);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // 'P'
    expect(buf[2]).toBe(0x4e); // 'N'
    expect(buf[3]).toBe(0x47); // 'G'
    const dims = readPngDims(buf);
    expect(dims.width).toBe(2560);
    expect(dims.height).toBe(1600);
  }
});

test("batch: a single failing item is reported and the queue continues", async ({ page }) => {
  // Mix a valid PNG with a garbage "image" file. The pipeline will fail to
  // decode the bad one but must keep processing the rest (PRD #27).
  const dir = mkdtempSync(join(tmpdir(), "imageto24-batch-resilience-e2e-"));
  const goodA = join(dir, "good-a.png");
  const bad = join(dir, "bad.png");
  const goodB = join(dir, "good-b.png");
  writeFileSync(goodA, makePng(160, 100, 200, 120, 60));
  writeFileSync(bad, Buffer.from("this is not a png at all"));
  writeFileSync(goodB, makePng(160, 100, 60, 200, 120));

  await page.goto("/");

  const batchInput = page.locator('input[type="file"][multiple]');
  await batchInput.setInputFiles([goodA, bad, goodB]);

  // Wait for the batch to settle.
  await expect(page.getByTestId("batch-summary")).toBeVisible({ timeout: 180_000 });

  // The bad item failed; the two good ones succeeded.
  await expect(page.getByTestId("batch-status-good-a.png-0")).toHaveText("done");
  await expect(page.getByTestId("batch-status-bad.png-1")).toHaveText("failed");
  await expect(page.getByTestId("batch-status-good-b.png-2")).toHaveText("done");

  // The failed row surfaces an error marker.
  await expect(page.getByTestId("batch-error-bad.png-1")).toBeVisible();

  // Summary reflects the mixed outcome: 2 of 3 done, 1 failed.
  await expect(page.getByTestId("batch-progress-text")).toContainText("1 failed");
  await expect(page.getByTestId("batch-summary")).toContainText("2 of 3 done");
});

test("batch: an unsupported file type shows as failed rather than vanishing", async ({ page }) => {
  // A valid image alongside a plain-text file. The text file has no decodable
  // image format; it must surface as a failed item (with a reason) instead of
  // being silently dropped from the queue — the user should see which file was
  // rejected (per-item resilience, PRD #27).
  const dir = mkdtempSync(join(tmpdir(), "imageto24-batch-unsupported-e2e-"));
  const good = join(dir, "good.png");
  const text = join(dir, "notes.txt");
  writeFileSync(good, makePng(160, 100, 200, 120, 60));
  writeFileSync(text, Buffer.from("just some text, not an image"));

  await page.goto("/");

  const batchInput = page.locator('input[type="file"][multiple]');
  await batchInput.setInputFiles([good, text]);

  await expect(page.getByTestId("batch-summary")).toBeVisible({ timeout: 180_000 });

  // Both files are represented — the text file is failed, not missing.
  await expect(page.getByTestId("batch-status-good.png-0")).toHaveText("done");
  await expect(page.getByTestId("batch-status-notes.txt-1")).toHaveText("failed");
  await expect(page.getByTestId("batch-error-notes.txt-1")).toBeVisible();
  await expect(page.getByTestId("batch-summary")).toContainText("1 failed");
});

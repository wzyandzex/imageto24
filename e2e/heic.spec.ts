import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPngDims } from "./fixtures/png";

/**
 * E2E tracer bullet for HEIC input (issue #17): the HEIC line's end-to-end
 * proof. Upload a real HEIC → faithful upscale → download a non-HEIC result,
 * asserting the downloaded file is a valid PNG at the expected 4K dimensions.
 *
 * This is the test the PRD testing decisions call out: "Playwright covers an
 * end-to-end upload → upscale → download for a real HEIC fixture." It exercises
 * the whole HEIC path that #15 wired into the decoder seam (heic2any lazy-loads
 * in the worker, converts HEIC→PNG, decodes that) plus #17's main-image wiring
 * (HEIC-aware upload, first-use converter indicator, never-HEIC output).
 *
 * The fixture is a committed real HEIC (`sample.heic`, ~1.5KB, ftyp brand
 * `heic`); a HEIC cannot be synthesized in Node, so a committed binary is the
 * only honest option (per the issue's testing decision). Its source is 320×180
 * (long edge 320), so a 4K faithful upscale lands at 3840×2160.
 */
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.heic",
);

test("HEIC: upload → faithful → 4K → download a valid PNG (never HEIC)", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-heic-e2e-"));
  const outPath = join(dir, "upscaled.png");

  await page.goto("/");

  // Upload the real HEIC via the hidden single-image file input.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(FIXTURE);

  // The HEIC placeholder renders (the browser can't preview HEIC), and the
  // dimensions line states they're read after conversion rather than crashing.
  await expect(page.getByTestId("heic-source-placeholder")).toBeVisible();
  await expect(page.getByTestId("original-dimensions")).toContainText(/HEIC|read after conversion/i);

  // Faithful is the default mode; select 4K.
  await page.getByTestId("tier-4K").click();

  // Trigger the upscale. The worker lazy-loads heic2any on first HEIC use,
  // converts, then runs the 4K Lanczos faithful upscale — all off the main
  // thread. Generous timeout: the one-time heic2any load + a 4K Lanczos pass.
  await page.getByTestId("upscale-button").click();

  // The first-use converter indicator appears while heic2any loads/runs. It may
  // flash past quickly on a warm cache, so we don't hard-assert it — we just let
  // the run proceed and wait for the terminal result (or an honest error).
  // 320-long-edge source × 4K (3840) ⇒ 3840×2160.
  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 2160", {
    timeout: 180_000,
  });

  // Download the result and capture it.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);

  // The downloaded file is a valid PNG at the expected 4K dimensions — and
  // crucially NOT HEIC (no browser-side HEIC encoder exists; output is never
  // HEIC, PRD §Out of scope). PNG signature + IHDR dimensions confirm both.
  const downloaded = readFileSync(outPath);
  expect(downloaded[0]).toBe(0x89);
  expect(downloaded[1]).toBe(0x50); // 'P'
  expect(downloaded[2]).toBe(0x4e); // 'N'
  expect(downloaded[3]).toBe(0x47); // 'G'
  const dims = readPngDims(downloaded);
  expect(dims.width).toBe(3840);
  expect(dims.height).toBe(2160);

  // The download filename reflects the non-HEIC output, not the input name's
  // .heic extension.
  const suggested = download.suggestedFilename();
  expect(suggested).toMatch(/\.png$/i);
  expect(suggested).not.toMatch(/\.heic$/i);
});

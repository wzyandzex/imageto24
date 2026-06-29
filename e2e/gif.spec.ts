import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readPngDims } from "./fixtures/png";
import { makeGif } from "./fixtures/gif";

/**
 * E2E for the animated-GIF detection + routing line (issue #16): upload an
 * animated GIF → see the detected frame count → see the honest "treated as a
 * still for now" notice → run the upscale (the placeholder first-frame path,
 * which delegates to processImage) → download a valid PNG at the expected 4K
 * dimensions.
 *
 * This is the test the PRD testing decisions call out: "A Playwright test
 * covers: upload an animated GIF, see the frame count, see the 'treated as
 * still for now' path." The fixture is a real, browser-decodable animated GIF
 * generated at runtime (3 frames, 1×1 each) — `detectAnimation` runs on its
 * real bytes, the browser decodes its first frame, and the faithful upscale
 * runs to completion through the `processAnimated` placeholder.
 *
 * The source is 1×1 (square); a 4K faithful upscale (long edge 3840) lands at
 * 3840×3840, aspect ratio preserved.
 */
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const ANIMATED_GIF = join(FIXTURE_DIR, "fixtures", "animated.gif");
const STILL_GIF = join(FIXTURE_DIR, "fixtures", "still.gif");

test.beforeAll(() => {
  // Write the fixtures once for the suite. A 3-frame animated GIF and a
  // single-frame still GIF — both browser-decodable.
  writeFileSync(ANIMATED_GIF, makeGif(3));
  writeFileSync(STILL_GIF, makeGif(1));
});

test("animated GIF: detected frame count + 'treated as still for now' notice", async ({ page }) => {
  await page.goto("/");

  // Upload the real animated GIF via the hidden single-image file input.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_GIF);

  // The animated notice renders: frame count (3) + the honest "still for now"
  // message. Both are the user-facing contract for the GIF line (PRD stories
  // #16/#17/#18). The frame count reads "3 frames".
  await expect(page.getByTestId("animated-gif-notice")).toBeVisible();
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);
  await expect(page.getByTestId("animated-gif-notice")).toContainText(
    /still image|first frame/i,
  );

  // The detection-only notices (animated WebP / APNG) must NOT show for a GIF.
  await expect(page.getByTestId("animated-webp-notice")).toHaveCount(0);
  await expect(page.getByTestId("apng-notice")).toHaveCount(0);
});

test("animated GIF: upscale runs via the processAnimated (placeholder) path → valid 4K PNG", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-gif-e2e-"));
  const outPath = join(dir, "upscaled.png");

  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_GIF);

  // Confirm the animated routing is in effect before running.
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);

  // Faithful is the default mode; select 4K.
  await page.getByTestId("tier-4K").click();

  // Trigger the upscale. The worker dispatches to processAnimated (the
  // placeholder), which delegates to processImage on the first frame. The
  // fixture is 1×1 (square), so a 4K faithful upscale (long edge 3840) lands at
  // 3840×3840 — aspect ratio preserved.
  await page.getByTestId("upscale-button").click();

  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 3840", {
    timeout: 180_000,
  });

  // Download the result and capture it.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);

  // The downloaded file is a valid PNG at the expected 4K dimensions — the
  // first-frame-fallback placeholder produces a real, usable still output.
  const downloaded = readFileSync(outPath);
  expect(downloaded[0]).toBe(0x89);
  expect(downloaded[1]).toBe(0x50); // 'P'
  expect(downloaded[2]).toBe(0x4e); // 'N'
  expect(downloaded[3]).toBe(0x47); // 'G'
  const dims = readPngDims(downloaded);
  expect(dims.width).toBe(3840);
  expect(dims.height).toBe(3840);
});

test("single-frame GIF: no animated notice, routes to the still path", async ({ page }) => {
  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(STILL_GIF);

  // A single-frame GIF is a still: none of the animated notices render. It
  // routes to processImage (no `animated` flag), matching v1's behaviour.
  await expect(page.getByTestId("animated-gif-notice")).toHaveCount(0);
  await expect(page.getByTestId("animated-frame-count")).toHaveCount(0);
  await expect(page.getByTestId("animated-webp-notice")).toHaveCount(0);
  await expect(page.getByTestId("apng-notice")).toHaveCount(0);
});

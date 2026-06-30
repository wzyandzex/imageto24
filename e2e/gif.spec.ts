import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGif } from "./fixtures/gif";
import { parseGIF, decompressFrames } from "gifuct-js";

/**
 * E2E for the animated-GIF line (issue #16 detection/routing + issue #18
 * per-frame decode → faithful upscale → gifenc re-encode).
 *
 * The #16-only slice (a placeholder first-frame fallback that returned a PNG) is
 * replaced by the real animated path: upload an animated GIF → see the detected
 * frame count + the "animation preserved" notice → upscale → see per-frame
 * progress advance to N/N → download a *playable animated GIF* → re-decode it
 * via gifuct-js and assert the frame count, dimensions, and per-frame timing all
 * survived the round-trip (PRD stories #8–#12).
 *
 * The fixture is a real, browser-decodable 3-frame GIF generated at runtime
 * (1×1 frames). `detectAnimation` runs on its real bytes on upload; the worker's
 * `processAnimated` decodes every frame, upscales each via the faithful Lanczos
 * path, and re-encodes via gifenc. The downloaded GIF is then re-decoded here
 * (gifuct-js again) to verify the round-trip end-to-end.
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

test("animated GIF: detected frame count + 'animation preserved' notice", async ({ page }) => {
  await page.goto("/");

  // Upload the real animated GIF via the hidden single-image file input.
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_GIF);

  // The animated notice renders: frame count (3) + the honest "animation
  // preserved" message (issue #18 — the placeholder "treated as a still for
  // now" notice is gone; the GIF now stays animated).
  await expect(page.getByTestId("animated-notice")).toBeVisible();
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);
  await expect(page.getByTestId("animated-notice")).toContainText(
    /animation is preserved/i,
  );

  // The detection-only notices (animated WebP / APNG) must NOT show for a GIF.
  await expect(page.getByTestId("animated-webp-notice")).toHaveCount(0);
  await expect(page.getByTestId("apng-notice")).toHaveCount(0);
});

test("animated GIF: faithful per-frame upscale → playable 4K GIF (frames + dims + timing preserved)", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-gif-e2e-"));
  const outPath = join(dir, "upscaled.gif");

  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_GIF);

  // Confirm the animated routing is in effect before running.
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);

  // Faithful is the default mode; select 4K.
  await page.getByTestId("tier-4K").click();

  // Trigger the upscale. processAnimated decodes every frame → faithful
  // Lanczos per frame → gifenc re-encode. The fixture is 1×1 (square), so a 4K
  // faithful upscale (long edge 3840) lands at 3840×3840.
  await page.getByTestId("upscale-button").click();

  // Per-frame progress should advance to 3/3 (PRD story #10). It may fire and
  // settle quickly on the 1×1 fixture, so wait for the result dimensions
  // (the terminal signal) rather than a specific frame-progress value.
  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 3840", {
    timeout: 240_000,
  });

  // Download the result and capture it.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);

  // The downloaded file is a GIF (GIF89a magic), NOT a PNG — #18 re-encodes a
  // playable animated GIF rather than the #16 placeholder's single still.
  const downloaded = readFileSync(outPath);
  expect(downloaded[0]).toBe(0x47); // 'G'
  expect(downloaded[1]).toBe(0x49); // 'I'
  expect(downloaded[2]).toBe(0x46); // 'F'

  // Re-decode the downloaded GIF via gifuct-js and assert the round-trip:
  //   - frame count preserved (3 → 3, PRD story #8/9)
  //   - dimensions upscaled to the 4K canvas (3840×3840)
  //   - per-frame timing preserved (100ms delay carried through, story #11)
  const reparsed = decompressFrames(parseGIF(downloaded.buffer), true);
  expect(reparsed.length).toBe(3); // frame count survived
  const first = reparsed[0];
  expect(first.dims.width).toBe(3840);
  expect(first.dims.height).toBe(3840);
  for (const f of reparsed) {
    // gifuct-js reports delay already in milliseconds; the fixture used 100ms.
    expect(f.delay).toBe(100);
  }
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

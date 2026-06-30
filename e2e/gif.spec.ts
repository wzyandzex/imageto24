import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGif } from "./fixtures/gif";
import { parseApng } from "./fixtures/apng";

/**
 * E2E for the animated-GIF line (issue #16 detection/routing + issue #18
 * per-frame decode → faithful upscale → re-encode).
 *
 * The #16-only slice (a placeholder first-frame fallback that returned a PNG) is
 * replaced by the real animated path: upload an animated GIF → see the detected
 * frame count + the "animation preserved" notice → upscale → see per-frame
 * progress advance to N/N → download a *playable animation* → re-parse it and
 * assert the frame count, dimensions, and per-frame timing all survived the
 * round-trip (PRD stories #8–#12).
 *
 * The fixture is a real, browser-decodable 3-frame GIF generated at runtime
 * (1×1 frames). `detectAnimation` runs on its real bytes on upload; the worker's
 * `processAnimated` decodes every frame, upscales each via the faithful Lanczos
 * path, and re-encodes. The downloaded file is then re-parsed here to verify the
 * round-trip end-to-end.
 *
 * **Output format is device-determined (issue #27 / ADR-0007).** Chromium has
 * WebCodecs `ImageDecoder`, so the resolved codec pair's `webCodecs===true`
 * branch fires and the encoder is UPNG.js — the animated output is **APNG**
 * (true-colour), not GIF. GIF output only happens on devices *without* WebCodecs
 * (the degrade path, exercised under Vitest via `animatedCodecPair.test.ts`).
 * The downloaded file is therefore a PNG-signatured APNG whose `acTL` chunk
 * carries the animation; this spec re-parses that structure. The source is 1×1
 * (square); a 4K faithful upscale (long edge 3840) lands at 3840×3840.
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

test("animated GIF: faithful per-frame upscale → playable 4K APNG (frames + dims + timing preserved, true-colour)", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-gif-e2e-"));
  const outPath = join(dir, "upscaled.png");

  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_GIF);

  // Confirm the animated routing is in effect before running.
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);

  // Faithful is the default mode; select 4K.
  await page.getByTestId("tier-4K").click();

  // Trigger the upscale. processAnimated decodes every frame → faithful
  // Lanczos per frame → re-encode. On Chromium the codec pair's webCodecs===true
  // branch fires (#27), so the encoder is UPNG.js (APNG, true-colour) rather
  // than gifenc (GIF, 256-colour). The fixture is 1×1 (square), so a 4K faithful
  // upscale (long edge 3840) lands at 3840×3840.
  await page.getByTestId("upscale-button").click();

  // Per-frame progress should advance to 3/3 (PRD story #10). It may fire and
  // settle quickly on the 1×1 fixture, so wait for the result dimensions
  // (the terminal signal) rather than a specific frame-progress value.
  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 3840", {
    timeout: 240_000,
  });

  // Download the result and capture it. The extension is `.png` because the
  // output is an APNG (PNG-signatured) on this device — see ADR-0007.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  await download.saveAs(outPath);

  // The downloaded file is an APNG (PNG signature), NOT a GIF. #27 re-encodes a
  // playable true-colour animation via UPNG.js on WebCodecs devices (ADR-0007).
  const downloaded = readFileSync(outPath);
  expect(downloaded[0]).toBe(0x89);
  expect(downloaded[1]).toBe(0x50); // 'P'
  expect(downloaded[2]).toBe(0x4e); // 'N'
  expect(downloaded[3]).toBe(0x47); // 'G'

  // Re-parse the downloaded APNG's chunk structure and assert the round-trip:
  //   - it is genuinely animated (carries an `acTL` chunk)
  //   - frame count preserved (3 → 3, PRD story #8/9)
  //   - dimensions upscaled to the 4K canvas (3840×3840)
  //   - colour type 6 ⇒ true-colour RGBA (no 256-colour quantization — the
  //     colour-fidelity point of #27; GIF would cap this)
  //   - per-frame timing preserved (100ms carried through, story #11)
  //   - every chunk's CRC is valid (well-formed file)
  const apng = parseApng(downloaded);
  expect(apng.animated).toBe(true);
  expect(apng.frameCount).toBe(3);
  expect(apng.width).toBe(3840);
  expect(apng.height).toBe(3840);
  expect(apng.colourType).toBe(6); // true-colour RGBA — the fidelity win
  expect(apng.crcsValid).toBe(true);
  expect(apng.delays).toEqual([100, 100, 100]);
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

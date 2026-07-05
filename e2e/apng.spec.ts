import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseApng } from "./fixtures/apng";
import { makeAnimatedApng } from "./fixtures/animatedApng";

/**
 * APNG input tracer bullet (issue #39): upload a real animated PNG, detect it as
 * multi-frame, route to processAnimated with the APNG decoder (#37), faithfully
 * upscale every frame, and re-encode as APNG. APNG input is the ADR-0007 v4
 * exception: output is always APNG, never degraded to GIF.
 */
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const ANIMATED_APNG = join(FIXTURE_DIR, "fixtures", "animated.apng");

test.beforeAll(() => {
  writeFileSync(ANIMATED_APNG, makeAnimatedApng());
});

test("animated APNG: detected frame count + APNG output notice", async ({ page }) => {
  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_APNG);

  await expect(page.getByTestId("animated-notice")).toBeVisible();
  await expect(page.getByTestId("animated-notice")).toContainText(/Animated PNG \(APNG\)/i);
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);
  await expect(page.getByTestId("apng-notice")).toHaveCount(0);

  await expect(page.getByTestId("animated-output-label")).toContainText(/APNG/i);
  await expect(page.getByTestId("animated-output-label")).toContainText(/true colour/i);
});

test("animated APNG: faithful per-frame upscale → playable 4K APNG", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-apng-e2e-"));
  const outPath = join(dir, "upscaled.apng");

  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(ANIMATED_APNG);
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/);

  await page.getByTestId("tier-4K").click();
  await page.getByTestId("upscale-button").click();

  await expect(page.getByTestId("result-dimensions")).toContainText("3840 × 3840", {
    timeout: 240_000,
  });
  await expect(page.getByTestId("download")).toContainText(/APNG/);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.apng$/i);
  await download.saveAs(outPath);

  const downloaded = readFileSync(outPath);
  expect(downloaded[0]).toBe(0x89);
  expect(downloaded[1]).toBe(0x50);
  expect(downloaded[2]).toBe(0x4e);
  expect(downloaded[3]).toBe(0x47);

  const apng = parseApng(downloaded);
  expect(apng.animated).toBe(true);
  expect(apng.frameCount).toBe(3);
  expect(apng.width).toBe(3840);
  expect(apng.height).toBe(3840);
  expect(apng.colourType).toBe(6);
  expect(apng.crcsValid).toBe(true);
  expect(apng.delays).toEqual([100, 150, 200]);
});

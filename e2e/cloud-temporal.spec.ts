import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeGradientGif as makeAnimatedGif } from "./fixtures/animatedGradientGif";
import { makePng } from "./fixtures/png";

/**
 * E2E for the v5 cloud temporal enhancement path (issues #58/#59/#60).
 *
 * Without `VITE_CLOUD_TEMPORAL_ENDPOINT`, production builds use the deterministic
 * no-network fake tracer with `autoAdvanceOnRead: true`. The UI's 2s poll then
 * naturally walks uploading → queued → processing → encoding → ready, which is
 * enough to verify the user-facing consent, recovery, download, and deletion
 * flows end-to-end against the real bundle.
 *
 * A real GPU HTTP service is a separate deployment effort; this suite locks the
 * browser contract that service must honour.
 */
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const ANIMATED_GIF = join(FIXTURE_DIR, "fixtures", "cloud-animated.gif");

test.beforeAll(() => {
  writeFileSync(ANIMATED_GIF, makeAnimatedGif());
});

async function switchToAiMode(page: import("@playwright/test").Page) {
  const ai = page.getByTestId("mode-ai");
  await expect(ai).toBeVisible();
  // Capability probe is async; wait until AI is actually selectable.
  await expect(ai).toHaveAttribute("aria-disabled", "false", { timeout: 30_000 });
  await ai.click();
  await expect(ai).toHaveAttribute("aria-selected", "true");
}

async function openApp(page: import("@playwright/test").Page) {
  await page.goto("/");
  // Guard against reusing an unrelated server on the preview port: the suite
  // must be talking to imageto24 before any file input is touched.
  await expect(page.getByRole("heading", { name: "imageto24", level: 1 })).toBeVisible({
    timeout: 30_000,
  });
}

async function uploadAnimatedAndOpenCloud(page: import("@playwright/test").Page) {
  await openApp(page);
  const fileInput = page.locator('input[type="file"]').first();
  await expect(fileInput).toBeAttached();
  await fileInput.setInputFiles(ANIMATED_GIF);
  await expect(page.getByTestId("animated-frame-count")).toContainText(/3 frames?/i);
  await switchToAiMode(page);
  await expect(page.getByTestId("cloud-temporal-control")).toBeVisible();
  await page.getByTestId("cloud-temporal-toggle").check();
  await expect(page.getByTestId("cloud-upload-consent-control")).toBeVisible();
  await expect(page.getByTestId("upscale-button")).toBeDisabled();
  await page.getByTestId("cloud-upload-consent").check();
  await expect(page.getByTestId("upscale-button")).toBeEnabled();
}

test("cloud temporal: consent-gated opt-in advances to ready with recovery + download", async ({ page }) => {
  await uploadAnimatedAndOpenCloud(page);

  // Default cloud output is APNG; strength defaults to Full AI (100%).
  await expect(page.getByTestId("cloud-output-format-apng")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("enhancement-strength-value")).toContainText("100%");

  await page.getByTestId("upscale-button").click();

  const panel = page.getByTestId("cloud-job-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("cloud-job-status")).toBeVisible();
  await expect(page.getByTestId("cloud-recovery-link")).toHaveValue(/#cloud-job=.+&token=.+/);
  await expect(page.getByTestId("cloud-job-retention")).toContainText(/Retained until/i);

  // Fake auto-advance under UI polling reaches ready without a real GPU service.
  await expect(page.getByTestId("cloud-result-ready")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("cloud-job-status")).toContainText(/Ready to download/i);
  await expect(page.getByTestId("cloud-result-download")).toContainText(/Download cloud APNG/i);

  // Hash recovery identity is written so a refresh can resume the retained job.
  await expect.poll(() => page.url()).toMatch(/#cloud-job=/);
});

test("cloud temporal: immediate deletion clears the download and recovery hash", async ({ page }) => {
  await uploadAnimatedAndOpenCloud(page);
  await page.getByTestId("upscale-button").click();

  await expect(page.getByTestId("cloud-result-ready")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("cloud-result-download")).toBeVisible();

  await page.getByTestId("cloud-job-delete").click();
  await expect(page.getByTestId("cloud-job-status")).toContainText(/deleted/i, { timeout: 15_000 });
  await expect(page.getByTestId("cloud-result-download")).toHaveCount(0);
  await expect(page.getByTestId("cloud-job-delete")).toBeDisabled();
  await expect.poll(() => new URL(page.url()).hash).toBe("");
});

test("cloud temporal: still images never offer the cloud path", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-cloud-still-"));
  const stillPath = join(dir, "still.png");
  writeFileSync(stillPath, makePng(64, 48, 10, 20, 30));

  await openApp(page);
  await page.locator('input[type="file"]').first().setInputFiles(stillPath);
  await expect(page.getByTestId("original-dimensions")).toBeVisible();
  await switchToAiMode(page);
  await expect(page.getByTestId("cloud-temporal-control")).toHaveCount(0);
});

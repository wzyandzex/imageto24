import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePng } from "./fixtures/png";

/**
 * E2E for issue #5: when capability is mocked unsupported (no WebGPU), the AI
 * option is visibly disabled with an honest explanation, while Faithful remains
 * offered as the selected universal fallback.
 */

test("device capability: unsupported WebGPU disables AI and offers Faithful", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "imageto24-capability-e2e-"));
  const srcPath = join(dir, "source.png");
  writeFileSync(srcPath, makePng(320, 180, 120, 140, 180));

  await page.addInitScript(() => {
    // Mock WebGPU as unsupported before the app's capability probe runs.
    Object.defineProperty(Navigator.prototype, "gpu", {
      configurable: true,
      get: () => undefined,
    });
  });

  await page.goto("/");

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(srcPath);

  const faithful = page.getByTestId("mode-faithful");
  const ai = page.getByTestId("mode-ai");

  await expect(faithful).toBeVisible();
  await expect(faithful).toHaveAttribute("aria-selected", "true");
  await expect(faithful).toContainText("Faithful");
  await expect(faithful).toContainText("Mathematically lossless");

  await expect(ai).toBeVisible();
  await expect(ai).toHaveAttribute("aria-disabled", "true");
  await expect(ai).toContainText("AI Enhance");
  await expect(ai).toContainText("needs WebGPU");
});

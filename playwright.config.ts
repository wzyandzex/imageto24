import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the image-upscaler e2e suite.
 *
 * The e2e tests (PRD testing decisions) cover the user-facing flows the
 * pure-function seam can't reach. They're intentionally thin: the Vitest suite
 * carries the weight. We run against the production Vite build via `vite preview`
 * so the test exercises the real bundle, including the Canvas/Lanczos path.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        // Reuse the system Chrome when available (channel: "chrome") so we don't
        // download a separate Playwright browser binary locally; CI still installs
        // Playwright's bundled chromium via `npx playwright install`.
        ...devices["Desktop Chrome"],
        channel: "chrome",
      },
    },
  ],
  webServer: {
    command: "npm run build && npm run preview -- --port 4173",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

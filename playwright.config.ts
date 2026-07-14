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
    // Dedicated preview port so local e2e never reuses an unrelated server that
    // happens to already listen on the default Vite preview port (4173).
    baseURL: "http://localhost:4174",
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
    command: "npm run build && npm run preview -- --port 4174 --strictPort",
    url: "http://localhost:4174",
    // Only reuse when CI is not set *and* the existing server is ours. Prefer a
    // fresh preview in local runs so a different app on this port cannot poison
    // the suite (Playwright only checks that the port answers, not the app).
    reuseExistingServer: false,
    timeout: 180_000,
  },
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (spec section 10). They run the app locally with a scripted
 * model in place of Workers AI, so they make no model call. Run them with
 * `npm run test:e2e`, which first writes wrangler.e2e.jsonc.
 */
const PORT = 5180;

export default defineConfig({
  testDir: "test/e2e",
  // The tests share one local agent, so they run one at a time, in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  outputDir: ".wrangler/e2e-results",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npx vite dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/api/version`,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { E2E_WRANGLER_CONFIG: "wrangler.e2e.jsonc" }
  }
});

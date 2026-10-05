import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

const DOMAIN = "src/domain/**";
// Browser code is covered by the end-to-end tests planned for phase 9.
const BROWSER_UI = ["src/app.tsx", "src/client.tsx", "src/components/**"];

/**
 * Coverage is measured in two separate runs (see the test:coverage script).
 * Measuring domain files in both projects at once made the merged figures
 * depend on run order, which failed CI while passing locally.
 *  - "domain": pure domain code, by the unit tests alone, at 95%.
 *  - anything else: the rest of the Worker, by the integration tests, at 80%.
 */
function coverageFor(scope: string | undefined) {
  const all = (percent: number) => ({
    lines: percent,
    branches: percent,
    functions: percent,
    statements: percent
  });
  // V8 coverage is not supported in the Workers pool.
  const provider = "istanbul" as const;
  return scope === "domain"
    ? { provider, include: [DOMAIN], thresholds: all(95) }
    : {
        provider,
        include: ["src/**"],
        exclude: [...BROWSER_UI, DOMAIN],
        thresholds: all(80)
      };
}

export default defineConfig({
  test: {
    projects: [
      {
        // Pure domain code: plain Node, no Cloudflare runtime.
        test: { name: "unit", include: ["test/unit/**/*.test.ts"] }
      },
      {
        // Agent and Worker code: runs inside the Workers runtime.
        plugins: [
          // Compiles the @callable decorator, as the app build does.
          agents(),
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Tests never call the real model, so no Cloudflare login is needed.
            remoteBindings: false,
            // Fixed test values, so the suite does not depend on .dev.vars.
            miniflare: {
              bindings: {
                CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
                CF_API_TOKEN: "test-token-not-a-real-credential"
              }
            }
          })
        ],
        define: { __COMMIT_SHA__: JSON.stringify("test-sha") },
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"]
        }
      }
    ],
    coverage: coverageFor(process.env.COVERAGE_SCOPE)
  }
});

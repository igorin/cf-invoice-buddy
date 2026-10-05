import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

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
          cloudflareTest({
            wrangler: { configPath: "./wrangler.jsonc" },
            // Tests never call the real model, so no Cloudflare login is needed.
            remoteBindings: false,
            // Fixed test values, so the suite does not depend on .dev.vars.
            miniflare: {
              bindings: { CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" }
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
    coverage: {
      // V8 coverage is not supported in the Workers pool.
      provider: "istanbul",
      include: ["src/**"],
      exclude: ["src/app.tsx", "src/client.tsx"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        "src/domain/**": {
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95
        }
      }
    }
  }
});

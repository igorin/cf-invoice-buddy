import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

// The deploy script sets GIT_SHA so /api/version can prove what is deployed.
const commitSha = process.env.GIT_SHA ?? "dev";

// The browser tests run on their own configuration and their own local
// state; see scripts/e2e-config.mjs.
const e2eConfig = process.env.E2E_WRANGLER_CONFIG;

export default defineConfig({
  define: { __COMMIT_SHA__: JSON.stringify(commitSha) },
  plugins: [
    agents(),
    react(),
    cloudflare(
      e2eConfig
        ? {
            configPath: e2eConfig,
            persistState: { path: ".wrangler/e2e-state" }
          }
        : {}
    ),
    tailwindcss()
  ]
});

import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import agents from "agents/vite";

// The deploy script sets GIT_SHA so /api/version can prove what is deployed.
const commitSha = process.env.GIT_SHA ?? "dev";

export default defineConfig({
  define: { __COMMIT_SHA__: JSON.stringify(commitSha) },
  plugins: [agents(), react(), cloudflare(), tailwindcss()]
});

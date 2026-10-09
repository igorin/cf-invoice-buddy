// Prepares the browser tests (spec section 10): writes wrangler.e2e.jsonc
// from the template and clears the local state the last run left.
//
// The e2e configuration differs from the template in two ways. It has no AI
// binding, so the tests need no Cloudflare login and make no model call, and
// it sets SCRIPTED_MODEL, which makes the agent answer from a fixed script
// (src/domain/scripted-model.ts). Both are possible only in local
// development.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fail } from "./lib.mjs";

const TEMPLATE = "wrangler.example.jsonc";
const TARGET = "wrangler.e2e.jsonc";
// Kept apart from the developer's own local state, and emptied each run so
// every run starts from the same place.
export const STATE_DIRECTORY = ".wrangler/e2e-state";

const AI_BINDING = '  "ai": { "binding": "AI", "remote": true },\n';
const LOCAL_ENVIRONMENT = '    "ENVIRONMENT": "local",\n';

const template = readFileSync(TEMPLATE, "utf8");
for (const [what, text] of [
  ["the AI binding", AI_BINDING],
  ["the local ENVIRONMENT variable", LOCAL_ENVIRONMENT]
]) {
  if (template.split(text).length !== 2) {
    fail(`${TEMPLATE} no longer has ${what} where the e2e setup expects it.`);
  }
}
writeFileSync(
  TARGET,
  template
    .replace(AI_BINDING, "")
    .replace(
      LOCAL_ENVIRONMENT,
      `${LOCAL_ENVIRONMENT}    "SCRIPTED_MODEL": "1",\n`
    )
);
rmSync(STATE_DIRECTORY, { recursive: true, force: true });
console.log(`✓ Wrote ${TARGET} and cleared ${STATE_DIRECTORY}.`);

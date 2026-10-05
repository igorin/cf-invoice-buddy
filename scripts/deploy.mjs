// One deployment path for both environments (spec section 13):
// guard → build → deploy → smoke → record. Usage: node scripts/deploy.mjs <env>
import { appendFileSync, existsSync } from "node:fs";
import { ENVIRONMENTS, WORKER_NAMES, currentPhase, fail, run } from "./lib.mjs";

const [environment, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
if (!ENVIRONMENTS.includes(environment)) {
  fail(
    `Usage: node scripts/deploy.mjs <${ENVIRONMENTS.join("|")}> [--dry-run]`
  );
}

const secretsFile = `.secrets/${environment}.env`;
const inherit = { stdio: "inherit" };

function guard() {
  if (run("git", ["status", "--porcelain"]) !== "") {
    fail("Working tree is not clean. Commit or stash first.");
  }
  run("git", ["fetch", "--quiet", "origin", "main"]);
  try {
    run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  } catch {
    fail("HEAD is not on origin/main. Only merged commits are deployed.");
  }
  if (!dryRun && !existsSync(secretsFile)) {
    fail(`Missing ${secretsFile}. See README, "Deploying".`);
  }
  if (environment === "production") {
    const staged = run("git", [
      "tag",
      "--points-at",
      "HEAD",
      "--list",
      "staging-ok/*"
    ]);
    if (staged === "")
      fail("This commit has not passed the staging smoke test.");
  }
}

guard();
const sha = run("git", ["rev-parse", "HEAD"]);
const shortSha = sha.slice(0, 12);
console.log(
  `→ Deploying ${shortSha} to ${environment}${dryRun ? " (dry run)" : ""}`
);

run("npx", ["vite", "build"], {
  ...inherit,
  env: { ...process.env, CLOUDFLARE_ENV: environment, GIT_SHA: sha }
});

if (dryRun) {
  run("npx", ["wrangler", "deploy", "--dry-run"], inherit);
  console.log("✓ Dry run complete. Nothing was uploaded.");
  process.exit(0);
}

run(
  "npx",
  [
    "wrangler",
    "deploy",
    "--secrets-file",
    secretsFile,
    "--message",
    `deploy ${shortSha}`
  ],
  inherit
);

let smokePassed = true;
try {
  run("node", ["scripts/smoke.mjs", environment, sha], inherit);
} catch {
  smokePassed = false;
}

if (!smokePassed) {
  if (environment === "production") {
    console.error("✗ Smoke test failed. Rolling back to the previous version.");
    run(
      "npx",
      [
        "wrangler",
        "rollback",
        "--name",
        WORKER_NAMES.production,
        "--yes",
        "--message",
        `smoke failed for ${shortSha}`
      ],
      inherit
    );
  }
  fail(`Smoke test failed on ${environment}. The phase gate stays closed.`);
}

const phase = currentPhase();
const when = new Date().toISOString();
appendFileSync(
  "spec/deployments.md",
  `| ${phase} | ${when} | ${environment} | ${shortSha} | passed |\n`
);

if (environment === "staging") {
  run("git", ["tag", "--force", `staging-ok/${shortSha}`]);
  console.log(`✓ Staging passed. Promote with: npm run deploy:production`);
} else {
  const tag = `deployed/phase-${phase}`;
  run("git", ["tag", "--force", tag]);
  run("git", ["push", "--force", "origin", tag]);
  console.log(
    `✓ Production passed. Pushed ${tag}; the next phase is unblocked.`
  );
}
console.log("Commit spec/deployments.md to keep the deployment record.");

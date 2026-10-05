// Phase gate (spec NFR-D1): work on phase n may not merge until phase n-1 is
// deployed, which is recorded by the tag deployed/phase-<n-1> on origin.
import { currentPhase, fail, run } from "./lib.mjs";

const phase = currentPhase();
if (phase === 1) {
  console.log("✓ Phase 1 has no earlier phase to wait for.");
  process.exit(0);
}

const required = `deployed/phase-${phase - 1}`;
const found = run("git", ["ls-remote", "--tags", "origin", required]);
if (found === "") {
  fail(`Phase ${phase} is blocked: tag ${required} does not exist on origin.`);
}
console.log(`✓ ${required} exists; phase ${phase} may proceed.`);

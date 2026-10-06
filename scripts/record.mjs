// Records the real model's raw streams for the replay tests (spec section
// 10). Each recording is one evaluation case that runs on test data; cases
// on live data are never recorded, because the repository is public.
//
// Usage: add RECORD_MODEL_CALLS=1 to .dev.vars
//        npm run dev      (in another terminal)
//        npm run record   [-- --only <case id>[,<case id>]]
//        npm run record -- --status     (no app and no model call needed)
//
// Then run `npm test`: a recording that does not replay to the same reply
// must not be committed.
//
// Recording calls the real model, one turn per case, on the local
// smoke-test instance and inside its neuron budget.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { CASES } from "../evals/cases.mjs";
import { openAgent } from "./agent-client.mjs";
import { fail, readEnvFile } from "./lib.mjs";

const BASE_URL = process.env.EVAL_URL ?? "http://localhost:5173";
const DIRECTORY = "test/cassettes";
const TURN_NEURON_ESTIMATE = 200;
// Values that must never reach a committed recording.
const PRIVATE_KEYS = ["CF_ACCOUNT_ID", "CF_API_TOKEN", "ACCESS_TEAM_DOMAIN"];

/** Changes when the prompt or a tool changes, which makes a recording stale. */
function fingerprint() {
  const hash = createHash("sha256");
  const tools = readdirSync("src/tools")
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `src/tools/${name}`);
  for (const file of ["src/prompt.ts", ...tools]) {
    hash.update(readFileSync(file));
  }
  return hash.digest("hex").slice(0, 16);
}

const recordable = CASES.filter((item) => item.scenario);
const current = fingerprint();

if (process.argv.includes("--status")) {
  for (const item of recordable) {
    const file = `${DIRECTORY}/${item.id}.json`;
    if (!existsSync(file)) {
      console.log(`– ${item.id}: not recorded`);
      continue;
    }
    const cassette = JSON.parse(readFileSync(file, "utf8"));
    console.log(
      cassette.fingerprint === current
        ? `✓ ${item.id}: recorded ${cassette.recordedOn}`
        : `✗ ${item.id}: recorded ${cassette.recordedOn}, before the prompt or a tool changed`
    );
  }
  process.exit(0);
}

const only = process.argv.includes("--only")
  ? (process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",")
  : null;
const cases = only
  ? recordable.filter((item) => only.includes(item.id))
  : recordable;
if (cases.length === 0) fail("No case on test data has that name.");

let session;
try {
  session = await (await fetch(`${BASE_URL}/api/session`)).json();
} catch {
  fail(`The app is not reachable at ${BASE_URL}. Start it with: npm run dev`);
}
const agent = await openAgent({
  baseUrl: BASE_URL,
  instance: `${session.accountId}-smoke`
});
await agent.call("getAssistantCost"); // Also waits for the first state frame.

const secrets = Object.entries(readEnvFile(".dev.vars"))
  .filter(([key, value]) => PRIVATE_KEYS.includes(key) && value.length >= 8)
  .map(([, value]) => value);

mkdirSync(DIRECTORY, { recursive: true });
let written = 0;
for (const item of cases) {
  const meter = agent.states.at(-1)?.selfCost;
  if (meter.windowNeurons + TURN_NEURON_ESTIMATE > meter.dailyBudgetNeurons) {
    console.log("Stopped: the instance's daily neuron budget would be passed.");
    break;
  }
  await agent.call("setDataMode", ["test", item.scenario]);
  agent.clearHistory();
  await agent.call("takeRecordedCalls"); // Discards anything left over.
  const recordedOn = new Date().toISOString().slice(0, 10);
  const turn = await agent.ask(item.question);
  const calls = await agent.call("takeRecordedCalls");
  if (calls.length === 0) {
    fail(
      "Nothing was recorded. Add RECORD_MODEL_CALLS=1 to .dev.vars and restart npm run dev."
    );
  }
  const cassette = {
    id: item.id,
    recordedOn,
    fingerprint: current,
    scenario: item.scenario,
    question: item.question,
    tools: turn.tools,
    reply: turn.text,
    calls
  };
  const text = `${JSON.stringify(cassette, null, 2)}\n`;
  if (secrets.some((value) => text.includes(value))) {
    console.log(`✗ ${item.id}: not saved, it contains a private value`);
    continue;
  }
  writeFileSync(`${DIRECTORY}/${item.id}.json`, text);
  written += 1;
  console.log(`✓ ${item.id}: ${calls.length} model calls recorded`);
}
await agent.call("setDataMode", ["live"]);
console.log(
  `${written} recordings written to ${DIRECTORY}. Run npm test before committing them.`
);
process.exit(0);

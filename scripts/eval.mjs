// Evaluation runner (spec section 10, NFR-T5). Asks the real model each case
// in evals/cases.mjs against a running app and grades the replies in code.
//
// Usage: npm run dev   (in another terminal)
//        npm run eval  [-- --changed [base] | --only <case id>[,<case id>]]
//
// --changed runs only the cases affected by the changes since base
// (default origin/main). A release needs a run of the whole suite.
//
// It runs on the local app's smoke-test instance, which has its own daily
// neuron budget, and stops before that budget or the account's free
// allowance would be passed.
import { mkdirSync, writeFileSync } from "node:fs";
import { CASES } from "../evals/cases.mjs";
import { ALLOWED_URLS } from "../evals/allowed-links.mjs";
import { checkGrounding } from "../src/domain/grounding.ts";
import { UNVERIFIED_MESSAGE } from "../src/domain/verified-stream.ts";
import { openAgent } from "./agent-client.mjs";
import { selectCases } from "../evals/select.ts";
import { accountNeuronsLast24Hours, fail, run } from "./lib.mjs";

const BASE_URL = process.env.EVAL_URL ?? "http://localhost:5173";
const RUNS = 3;
// Enough for one turn with a tool call and a growing-free context.
const TURN_NEURON_ESTIMATE = 200;
// Capability cases must pass for this share of cases (spec NFR-T5).
const CAPABILITY_PASS_SHARE = 0.9;
// The account's free allowance, less a margin for the analytics' delay.
const ACCOUNT_CEILING = 9_500;

// Which cases to run. Every case costs model calls, so day-to-day runs take
// only the cases a change affects; a release needs the whole suite.
const option = (name) =>
  process.argv.includes(name)
    ? (process.argv[process.argv.indexOf(name) + 1] ?? "")
    : null;

function changedFilesSince(base) {
  const list = (args) => run("git", args).split("\n").filter(Boolean);
  return [
    ...new Set([
      ...list(["diff", "--name-only", `${base}...HEAD`]),
      ...list(["diff", "--name-only", "HEAD"]),
      ...list(["ls-files", "--others", "--exclude-standard"])
    ])
  ];
}

function chooseCases() {
  const only = option("--only");
  if (only !== null) {
    const ids = only.split(",");
    const unknown = ids.filter((id) => !CASES.some((item) => item.id === id));
    if (only === "" || unknown.length > 0) {
      fail(`No case named ${unknown.join(", ") || "(none given)"}`);
    }
    return {
      scope: ids.length === CASES.length ? "full" : "only",
      cases: CASES.filter((item) => ids.includes(item.id))
    };
  }
  const changed = option("--changed");
  if (changed === null) return { scope: "full", cases: CASES };
  const base =
    changed === "" || changed.startsWith("--") ? "origin/main" : changed;
  const selection = selectCases(changedFilesSince(base), CASES);
  console.log(
    selection.because
      ? `Every case runs: ${selection.because} can affect any reply.`
      : `Changes since ${base} affect ${selection.cases.length} of ${CASES.length} cases.`
  );
  return selection;
}

const { scope, cases } = chooseCases();
if (cases.length === 0) {
  console.log("No evaluation case is affected. Nothing to run.");
  process.exit(0);
}

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

const meter = () => agent.states.at(-1)?.selfCost;

function gradeGrounding(turn, question) {
  const explain = turn.outputs.find(
    (o) => o.tool === "explainBillChange"
  )?.output;
  return checkGrounding({
    text: turn.text,
    toolResults: turn.outputs.map((o) => o.output),
    ownerText: question,
    docsUrls: turn.outputs
      .filter((o) => o.tool === "searchCloudflareDocs")
      .flatMap((o) => (o.output?.results ?? []).map((result) => result.url)),
    allowedUrls: ALLOWED_URLS,
    explainOutcome:
      typeof explain?.outcome === "string" ? explain.outcome : null
  }).map((violation) => `${violation.rule}: ${violation.detail}`);
}

async function runOnce(item) {
  const budget = meter();
  if (budget.windowNeurons + TURN_NEURON_ESTIMATE > budget.dailyBudgetNeurons) {
    throw new Error("the instance's daily neuron budget would be passed");
  }
  // The account's allowance is shared with everything else that runs on it.
  const spent = budget.windowNeurons - startNeurons;
  if (accountAtStart + spent + TURN_NEURON_ESTIMATE > ACCOUNT_CEILING) {
    throw new Error("the account's free allowance would be passed");
  }
  await agent.call(
    "setDataMode",
    item.scenario ? ["test", item.scenario] : ["live"]
  );
  // After the switch, so the switch notice is not part of the context.
  agent.clearHistory();
  const facts = item.scenario ? await agent.call("explainBill") : null;
  const started = Date.now();
  const turn = await agent.ask(item.question);
  const context = { facts, modeAfter: agent.states.at(-1)?.dataMode };
  const problems = [
    ...(turn.text.trim() === "" ? ["empty reply"] : []),
    ...item.checks.map((check) => check(turn, context)).filter(Boolean),
    ...gradeGrounding(turn, item.question)
  ];
  return {
    passed: problems.length === 0,
    problems,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    tools: turn.tools,
    // The app held this reply back: nothing unverified reached the owner,
    // but the owner got no answer either.
    withheld: turn.text.includes(UNVERIFIED_MESSAGE),
    reply: turn.text
  };
}

const startNeurons = meter().windowNeurons;
let accountAtStart;
try {
  accountAtStart = await accountNeuronsLast24Hours();
} catch (error) {
  fail(`Not run: ${error.message}. No model call is made without that figure.`);
}
console.log(
  `Account neurons in the last 24 hours: ${Math.round(accountAtStart).toLocaleString("en-US")} of 10,000 free. The run stops before ${ACCOUNT_CEILING.toLocaleString("en-US")}.`
);
const results = [];
let stopped = null;

for (const item of cases) {
  const runs = [];
  try {
    for (let run = 0; run < RUNS; run++) {
      runs.push(await runOnce(item));
      // A capability case needs one pass; a grounding case needs all three,
      // so it stops at its first failure. Both save model calls.
      const last = runs.at(-1);
      if (item.set === "capability" ? last.passed : !last.passed) break;
    }
  } catch (error) {
    stopped = error.message;
  }
  const passes = runs.filter((run) => run.passed).length;
  const passed =
    runs.length > 0 &&
    (item.set === "capability" ? passes > 0 : passes === RUNS);
  results.push({ ...item, checks: undefined, runs, passed });
  const mark = runs.length === 0 ? "–" : passed ? "✓" : "✗";
  console.log(
    `${mark} [${item.set}] ${item.id}: ${passes}/${runs.length} runs passed`
  );
  for (const run of runs.filter((r) => !r.passed)) {
    console.log(`    ${run.problems.join("; ")}`);
    console.log(`    reply: ${run.reply.slice(0, 300).replace(/\s+/g, " ")}`);
  }
  if (stopped) break;
}

await agent.call("setDataMode", ["live"]).catch(() => {});
const neurons = Math.round(meter().windowNeurons - startNeurons);
agent.close();

const of = (set) =>
  results.filter((result) => result.set === set && result.runs.length > 0);
const grounding = of("grounding");
const capability = of("capability");
const groundingOk =
  grounding.length > 0 && grounding.every((result) => result.passed);
const capabilityShare =
  capability.length === 0
    ? null
    : capability.filter((result) => result.passed).length / capability.length;
const complete = !stopped && results.length === cases.length;

const summary = {
  ranAt: new Date().toISOString(),
  baseUrl: BASE_URL,
  scope,
  complete,
  stoppedBecause: stopped,
  neurons,
  turns: results.reduce((total, result) => total + result.runs.length, 0),
  withheld: results.reduce(
    (total, result) => total + result.runs.filter((run) => run.withheld).length,
    0
  ),
  grounding: {
    passed: grounding.filter((r) => r.passed).length,
    of: grounding.length
  },
  capability: {
    passed: capability.filter((r) => r.passed).length,
    of: capability.length
  },
  results
};
mkdirSync("evals/results", { recursive: true });
const file = `evals/results/${summary.ranAt.slice(0, 19).replace(/[:T]/g, "-")}.json`;
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);

console.log(
  `\nGrounding: ${summary.grounding.passed}/${summary.grounding.of} cases (all must pass, three runs each)`
);
console.log(
  `Capability: ${summary.capability.passed}/${summary.capability.of} cases (${Math.round(CAPABILITY_PASS_SHARE * 100)}% must pass, one run in three)`
);
console.log(
  `${summary.turns} model turns, ${neurons} neurons. Results: ${file}`
);
console.log(
  `${summary.withheld} of ${summary.turns} replies were withheld by the response checker.`
);
if (stopped) console.log(`Stopped early: ${stopped}.`);
if (scope !== "full") {
  console.log(
    `Partial run (${cases.length} of ${CASES.length} cases): not a release result.`
  );
}

const ok =
  complete &&
  groundingOk &&
  (capabilityShare === null || capabilityShare >= CAPABILITY_PASS_SHARE);
process.exit(ok ? 0 : 1);

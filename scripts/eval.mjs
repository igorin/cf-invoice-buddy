// Evaluation runner (spec section 10, NFR-T5). Asks the real model each case
// in evals/cases.mjs against a running app and grades the replies in code.
//
// Usage: npm run dev   (in another terminal)
//        npm run eval  [-- --only <case id>]
//
// It runs on the local app's smoke-test instance, which has its own daily
// neuron budget, and stops before that budget or the account's free
// allowance would be passed.
import { mkdirSync, writeFileSync } from "node:fs";
import { CASES } from "../evals/cases.mjs";
import { checkGrounding } from "../src/domain/grounding.ts";
import { openAgent } from "./agent-client.mjs";
import { fail } from "./lib.mjs";

const BASE_URL = process.env.EVAL_URL ?? "http://localhost:5173";
const RUNS = 3;
// Enough for one turn with a tool call and a growing-free context.
const TURN_NEURON_ESTIMATE = 200;
// Capability cases must pass for this share of cases (spec NFR-T5).
const CAPABILITY_PASS_SHARE = 0.9;
const ALLOWED_URLS = [
  "https://developers.cloudflare.com/support/contacting-cloudflare-support/"
];

const only = process.argv.includes("--only")
  ? process.argv[process.argv.indexOf("--only") + 1]
  : null;
const cases = only ? CASES.filter((item) => item.id === only) : CASES;
if (cases.length === 0) fail(`No case named ${only}`);

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
  if (budget.todayNeurons + TURN_NEURON_ESTIMATE > budget.dailyBudgetNeurons) {
    throw new Error("the instance's daily neuron budget would be passed");
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
    reply: turn.text
  };
}

const startNeurons = meter().todayNeurons;
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
const neurons = Math.round(meter().todayNeurons - startNeurons);
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
  complete,
  stoppedBecause: stopped,
  neurons,
  turns: results.reduce((total, result) => total + result.runs.length, 0),
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
if (stopped) console.log(`Stopped early: ${stopped}.`);

const ok =
  complete &&
  groundingOk &&
  (capabilityShare === null || capabilityShare >= CAPABILITY_PASS_SHARE);
process.exit(ok ? 0 : 1);

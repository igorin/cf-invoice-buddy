// Post-deploy smoke test (spec section 13). Runs against the live URL.
// Usage: node scripts/smoke.mjs <staging|production> <expected commit sha>
// Reads .secrets/smoke.env: SMOKE_URL_STAGING, SMOKE_URL_PRODUCTION,
// CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET.
//
// The chat checks use the account's dedicated smoke-test agent instance, so
// smoke runs never write into the owner's own conversation.
import { spawn } from "node:child_process";
import { openAgent } from "./agent-client.mjs";
import { ENVIRONMENTS, WORKER_NAMES, fail, readEnvFile } from "./lib.mjs";

const [environment, expectedSha] = process.argv.slice(2);
if (!ENVIRONMENTS.includes(environment) || !expectedSha) {
  fail("Usage: node scripts/smoke.mjs <staging|production> <commit sha>");
}

const secrets = { ...readEnvFile(".secrets/smoke.env"), ...process.env };
const baseUrl = secrets[`SMOKE_URL_${environment.toUpperCase()}`];
if (!baseUrl) fail(`SMOKE_URL_${environment.toUpperCase()} is not set`);

const accessHeaders = {
  "CF-Access-Client-Id": secrets.CF_ACCESS_CLIENT_ID,
  "CF-Access-Client-Secret": secrets.CF_ACCESS_CLIENT_SECRET
};
const VERSION_WAIT_MS = 90_000;
const VERSION_POLL_MS = 3_000;
// The live log stream takes several seconds to attach and to flush.
const LOG_ATTACH_MS = 15_000;
const LOG_FLUSH_MS = 8_000;
const FAILED_OUTCOMES = new Set([
  "exception",
  "exceededCpu",
  "exceededMemory",
  "scriptNotFound"
]);
// A healthy reply almost never repeats a word back to back; the stream
// duplication defect (spec B8) repeats nearly all of them.
const MAX_REPEATED_WORD_RATIO = 0.2;
const TEST_SCENARIO = "zero-bill";
const SPIKE_SCENARIO = "usage-spike";
const DOLLAR_AMOUNT = /-?\$[\d,]+(?:\.\d+)?/g;
// Free-tier guard. Workers AI gives the account 10,000 neurons a day. A run
// uses a few hundred; it makes one model turn and is refused when the account or the smoke instance
// does not clearly have room, so a faulty run can never eat the allowance.
const ACCOUNT_DAILY_NEURON_LIMIT = 10_000;
const WINDOW_HOURS = 24;
const ACCOUNT_NEURON_RESERVE = 2_000;
const RUN_NEURON_ESTIMATE = 250;

const results = [];
async function check(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.error(`✗ ${name}: ${error.message}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function repeatedWordRatio(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return 0;
  const repeats = words.filter((word, i) => i > 0 && word === words[i - 1]);
  return repeats.length / (words.length - 1);
}

/** True when the text contains the figure on its own, not inside a longer number. */
function quotesFigure(text, figure) {
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d,.])${escaped}(?![\\d,]|\\.\\d)`).test(text);
}

/** Splits a stream of concatenated, pretty-printed JSON objects. */
function parseJsonStream(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          objects.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // A partial object at the end of the stream is ignored.
        }
        start = -1;
      }
    }
  }
  return objects;
}

/**
 * Follows the Worker's live logs for the duration of the smoke run.
 * Log events contain request headers, so their content is never printed.
 */
async function followLogs() {
  const tail = spawn(
    "./node_modules/.bin/wrangler",
    ["tail", WORKER_NAMES[environment], "--format", "json"],
    { stdio: ["ignore", "pipe", "ignore"] }
  );
  let output = "";
  tail.stdout.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolve) => setTimeout(resolve, LOG_ATTACH_MS));
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, LOG_FLUSH_MS));
    tail.kill();
    return parseJsonStream(output);
  };
}

/**
 * The account's Workers AI neurons over the trailing 24 hours, from GraphQL
 * Analytics. Cloudflare documents a limit that resets at 00:00 UTC, but on
 * 2026-10-06 it refused calls over usage made the day before, so the check
 * uses the trailing 24 hours, which is never looser than the calendar day.
 */
async function accountNeuronsLast24Hours() {
  const credentials = { ...readEnvFile(".dev.vars"), ...process.env };
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000);
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.CF_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query: `query($account: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $account }) {
        rows: aiInferenceAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { totalNeurons } }
      } } }`,
      variables: {
        account: credentials.CF_ACCOUNT_ID,
        since: since.toISOString(),
        until: now.toISOString()
      }
    })
  });
  const body = await response.json();
  const rows = body.data?.viewer?.accounts?.[0]?.rows;
  if (!response.ok || !Array.isArray(rows)) {
    throw new Error("the account's neuron usage could not be read");
  }
  return rows.reduce((total, row) => total + (row.sum?.totalNeurons ?? 0), 0);
}

try {
  const used = await accountNeuronsLast24Hours();
  const ceiling = ACCOUNT_DAILY_NEURON_LIMIT - ACCOUNT_NEURON_RESERVE;
  console.log(
    `Account neurons in the last ${WINDOW_HOURS} hours: ${Math.round(used).toLocaleString("en-US")} of ${ACCOUNT_DAILY_NEURON_LIMIT.toLocaleString("en-US")} free`
  );
  if (used + RUN_NEURON_ESTIMATE > ceiling) {
    fail(
      `Smoke test not run: the account would pass ${ceiling.toLocaleString("en-US")} neurons in ${WINDOW_HOURS} hours. Room frees up as earlier usage passes the ${WINDOW_HOURS}-hour mark.`
    );
  }
} catch (error) {
  fail(
    `Smoke test not run: ${error.message}. No model call is made without that figure.`
  );
}

// The deploy script runs this part alone before it uploads anything, so a
// deploy that could not be verified is never made.
if (process.argv.includes("--preflight")) {
  console.log("✓ There is room in the free allowance for a smoke run.");
  process.exit(0);
}

const stopLogs = await followLogs();

await check("a request with no credentials is refused", async () => {
  const response = await fetch(`${baseUrl}/api/version`, {
    redirect: "manual"
  });
  expect(response.status !== 200, `got HTTP ${response.status}`);
});

// A new version takes a few seconds to reach every location. Seen in the
// rollback drill: a deploy straight after a rollback still served the old
// commit for a moment. Wait for the intended commit before judging it.
async function waitForVersion() {
  const deadline = Date.now() + VERSION_WAIT_MS;
  let last = { status: 0, version: {} };
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/version`, {
      headers: accessHeaders
    });
    const version = await response.json().catch(() => ({}));
    last = { status: response.status, version };
    if (response.status === 200 && version.commit === expectedSha) break;
    await new Promise((resolve) => setTimeout(resolve, VERSION_POLL_MS));
  }
  return last;
}

await check("the deployed version is the intended commit", async () => {
  const { status, version } = await waitForVersion();
  expect(
    status === 200,
    `got HTTP ${status}${version.invalid ? `, invalid: ${version.invalid.join(", ")}` : ""}`
  );
  expect(version.configOk === true, "configuration is incomplete");
  expect(
    version.environment === environment,
    `environment is ${version.environment}`
  );
  expect(
    version.commit === expectedSha,
    `commit is ${String(version.commit).slice(0, 12)}`
  );
});

let accountId;
await check("the session endpoint names the account", async () => {
  const response = await fetch(`${baseUrl}/api/session`, {
    headers: accessHeaders
  });
  expect(response.status === 200, `got HTTP ${response.status}`);
  accountId = (await response.json()).accountId;
  expect(typeof accountId === "string", "no account id returned");
});

await check("another account's agent instance is refused", async () => {
  const response = await fetch(
    `${baseUrl}/agents/invoice-buddy-agent/someone-else/get-messages`,
    { headers: accessHeaders }
  );
  expect(response.status === 403, `got HTTP ${response.status}`);
});

let agent;
let liveSummary;
await check(
  "the usage summary shows the account's real usage (UC-9)",
  async () => {
    expect(accountId, "no session");
    agent = await openAgent({
      baseUrl,
      headers: accessHeaders,
      instance: `${accountId}-smoke`
    });
    agent.clearHistory();
    liveSummary = await agent.call("getUsageSummary");
    expect(liveSummary.dataset === "live", `dataset is ${liveSummary.dataset}`);
    const failed = new Set(
      liveSummary.unavailable.map((entry) => entry.service)
    );
    const shownAsZero = liveSummary.rows.filter((row) =>
      failed.has(row.service)
    );
    expect(
      shownAsZero.length === 0,
      "a product that could not be read has a row"
    );
    const neurons = liveSummary.rows.find(
      (row) => row.service === "Workers AI" && row.metric === "neurons"
    );
    expect(
      failed.has("Workers AI") || (neurons && neurons.quantity > 0),
      "no Workers AI usage, though this app has used the model"
    );
    console.log(
      `  ${liveSummary.rows.length} usage rows, ${liveSummary.unavailable.length} product(s) unavailable, billing: ${liveSummary.billing.status}`
    );
  }
);

await check(
  "test mode serves fixture data and leaves live data unchanged (UC-10)",
  async () => {
    expect(agent && liveSummary, "no agent session");
    await agent.call("setDataMode", ["test", TEST_SCENARIO]);
    try {
      const inTest = await agent.call("getUsageSummary");
      expect(
        inTest.dataset === "test",
        `dataset is ${inTest.dataset} in test mode`
      );
      expect(
        inTest.scenario === TEST_SCENARIO,
        `scenario is ${inTest.scenario}`
      );
      expect(inTest.rows.length > 0, "the scenario has no rows");
    } finally {
      await agent.call("setDataMode", ["live"]);
    }
    const after = await agent.call("getUsageSummary");
    expect(after.dataset === "live", "did not return to live data");
    expect(
      JSON.stringify(after.rows) === JSON.stringify(liveSummary.rows),
      "live figures changed after a visit to test mode"
    );
  }
);

await check(
  "documentation search returns Cloudflare pages (G-2, G-7)",
  async () => {
    expect(agent, "no agent session");
    const found = await agent.call("searchDocs", ["Workers AI pricing"]);
    expect(found.ok, `search failed: ${found.reason}`);
    expect(found.results.length > 0, "no pages returned");
    const foreign = found.results.filter(
      (page) => !page.url.startsWith("https://developers.cloudflare.com/")
    );
    expect(
      foreign.length === 0,
      "a page outside Cloudflare's documentation was returned"
    );
    console.log(
      `  ${found.results.length} pages, all on developers.cloudflare.com`
    );
  }
);

await check(
  "a bill explanation is grounded, labelled, undoubled and metered (UC-1, UC-8, G-9)",
  async () => {
    expect(agent, "no agent session");
    await agent.call("setDataMode", ["test", SPIKE_SCENARIO]);
    try {
      const facts = await agent.call("explainBill");
      expect(facts.outcome === "explained", `outcome is ${facts.outcome}`);
      // The one model turn of the run. The meter is real in test mode too.
      const before = agent.states.at(-1)?.selfCost;
      expect(before, "no meter state received");
      expect(
        before.windowNeurons + RUN_NEURON_ESTIMATE <= before.dailyBudgetNeurons,
        `the smoke instance has used ${Math.round(before.windowNeurons)} of its ${before.dailyBudgetNeurons} neurons in the last 24 hours; no model call made`
      );
      const {
        text,
        tools,
        error: turnError
      } = await agent.ask("Why is my bill higher than usual?");
      const after = agent.states.at(-1)?.selfCost;
      // The reply holds fixture figures only, so it is safe to print.
      const show = (problem) => `${problem}. Reply was: ${text.slice(0, 400)}`;
      expect(
        !turnError || !/free daily allowance/i.test(turnError),
        "Cloudflare refused the model call: the account's free daily allowance is used up. Nothing is wrong with the deploy; it cannot be verified until Cloudflare resets the allowance"
      );
      expect(!turnError, `the turn failed: ${turnError}`);
      expect(text.trim().length > 0, "empty reply");
      expect(
        tools.includes("explainBillChange"),
        show("the explain tool was not called")
      );
      // Grounding (rule G-1): every dollar amount in the reply must be one
      // the tool returned. Which amounts the model chooses to mention varies
      // from run to run, so no particular one is required.
      const known = JSON.stringify(facts);
      const amounts = text.match(DOLLAR_AMOUNT) ?? [];
      const invented = amounts.filter(
        (amount) =>
          !known.includes(`"${amount}"`) && !quotesFigure(known, amount)
      );
      expect(amounts.length > 0, show("the reply states no amount"));
      expect(
        invented.length === 0,
        show(`amounts not in the tool result: ${invented.join(", ")}`)
      );
      expect(
        /test data/i.test(text),
        show("the reply does not say the figures are test data")
      );
      const ratio = repeatedWordRatio(text);
      expect(
        ratio <= MAX_REPEATED_WORD_RATIO,
        show(`the reply repeats words (${Math.round(ratio * 100)}%)`)
      );
      expect(after, "no meter state received after the turn");
      expect(
        after.windowNeurons > before.windowNeurons,
        "the turn was not metered"
      );
      expect(
        after.unmeteredTurns === before.unmeteredTurns,
        "the turn was recorded as unmetered"
      );
      console.log(
        `  ${amounts.length} amounts stated, all from the tool result; labelled as test data; meter: ${before.windowNeurons.toFixed(2)} → ${after.windowNeurons.toFixed(2)} neurons in 24 hours`
      );
    } finally {
      await agent.call("setDataMode", ["live"]);
    }
  }
);

agent?.close();

await check("the Workers logs show no errors for this run", async () => {
  const events = await stopLogs();
  expect(events.length > 0, "no log events were captured");
  const badOutcomes = events.filter((event) =>
    FAILED_OUTCOMES.has(event.outcome)
  );
  const exceptions = events.flatMap((event) => event.exceptions ?? []);
  const errorLogs = events
    .flatMap((event) => event.logs ?? [])
    .filter((log) => log.level === "error");
  const maxCpuMs = Math.max(...events.map((event) => event.cpuTime ?? 0));
  console.log(`  ${events.length} log events, peak CPU ${maxCpuMs} ms`);
  expect(
    badOutcomes.length === 0,
    `${badOutcomes.length} failed invocation(s): ${[...new Set(badOutcomes.map((event) => event.outcome))].join(", ")}`
  );
  expect(exceptions.length === 0, `${exceptions.length} uncaught exception(s)`);
  expect(errorLogs.length === 0, `${errorLogs.length} error-level log line(s)`);
});

const failed = results.filter((result) => !result.ok);
console.log(
  `${results.length - failed.length}/${results.length} smoke checks passed on ${environment}`
);
process.exit(failed.length === 0 ? 0 : 1);

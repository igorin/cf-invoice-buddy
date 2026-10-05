// Post-deploy smoke test (spec section 13). Runs against the live URL.
// Usage: node scripts/smoke.mjs <staging|production> <expected commit sha>
// Reads .secrets/smoke.env: SMOKE_URL_STAGING, SMOKE_URL_PRODUCTION,
// CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET.
//
// The chat checks use the account's dedicated smoke-test agent instance, so
// smoke runs never write into the owner's own conversation.
import { spawn } from "node:child_process";
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
const TURN_TIMEOUT_MS = 90_000;
const RPC_TIMEOUT_MS = 30_000;
const VERSION_WAIT_MS = 90_000;
const VERSION_POLL_MS = 3_000;
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_MS = 5_000;
// The meter state follows the last chat frame; allow it a moment.
const STATE_SETTLE_MS = 5_000;
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
const EXPLAIN_ATTEMPTS = 2;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function repeatedWordRatio(text) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 2) return 0;
  const repeats = words.filter((word, i) => i > 0 && word === words[i - 1]);
  return repeats.length / (words.length - 1);
}

// Matches the app's own formatting of a quantity (src/tools/usage-summary-tool.ts).
const formatQuantity = (value) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** True when the text contains the figure on its own, not inside a longer number. */
function quotesFigure(text, figure) {
  const escaped = figure.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d,.])${escaped}(?![\\d,]|\\.\\d)`).test(text);
}

/** Opens the agent's WebSocket, retrying a failed connection after a deploy. */
async function connect(instance) {
  const url = `${baseUrl.replace(/^http/, "ws")}/agents/invoice-buddy-agent/${instance}`;
  for (let attempt = 1; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(url, { headers: accessHeaders });
        socket.onopen = () => resolve(socket);
        socket.onerror = () => reject(new Error("WebSocket connection failed"));
      });
    } catch (error) {
      if (attempt === CONNECT_ATTEMPTS) throw error;
      console.log(
        `  connection failed, retrying (${attempt}/${CONNECT_ATTEMPTS})`
      );
      await sleep(CONNECT_RETRY_MS);
    }
  }
}

/** A session with the agent: method calls, one chat turn, and state updates. */
async function openAgent(instance) {
  const socket = await connect(instance);
  const pending = new Map();
  const states = [];
  let onChatFrame = () => {};
  let calls = 0;
  socket.onmessage = (event) => {
    let frame;
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (frame.type === "cf_agent_state") states.push(frame.state);
    if (frame.type === "cf_agent_use_chat_response") onChatFrame(frame);
    if (frame.type === "rpc" && pending.has(frame.id)) {
      const { resolve, reject } = pending.get(frame.id);
      pending.delete(frame.id);
      if (frame.success) resolve(frame.result);
      else reject(new Error(frame.error ?? "call failed"));
    }
  };
  return {
    states,
    close: () => socket.close(),
    call(method, args = []) {
      return new Promise((resolve, reject) => {
        const id = `smoke-rpc-${++calls}`;
        const timer = setTimeout(
          () => reject(new Error(`${method} timed out`)),
          RPC_TIMEOUT_MS
        );
        pending.set(id, {
          resolve: (value) => (clearTimeout(timer), resolve(value)),
          reject: (error) => (clearTimeout(timer), reject(error))
        });
        socket.send(JSON.stringify({ type: "rpc", id, method, args }));
      });
    },
    ask(question) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("chat turn timed out")),
          TURN_TIMEOUT_MS
        );
        let text = "";
        const tools = new Set();
        onChatFrame = (frame) => {
          try {
            const part = JSON.parse(frame.body);
            if (part.type === "text-delta") text += part.delta ?? "";
            if (part.toolName) tools.add(part.toolName);
          } catch {
            // Frames without a JSON body carry no text.
          }
          if (frame.done) {
            clearTimeout(timer);
            sleep(STATE_SETTLE_MS).then(() =>
              resolve({ text, tools: [...tools] })
            );
          }
        };
        socket.send(
          JSON.stringify({
            type: "cf_agent_use_chat_request",
            id: `smoke-${Date.now()}`,
            init: {
              method: "POST",
              body: JSON.stringify({
                messages: [
                  {
                    id: `smoke-user-${Date.now()}`,
                    role: "user",
                    parts: [{ type: "text", text: question }]
                  }
                ]
              })
            }
          })
        );
      });
    }
  };
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
    agent = await openAgent(`${accountId}-smoke`);
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

await check("a usage answer is grounded, undoubled and metered", async () => {
  expect(agent && liveSummary, "no agent session");
  const before = agent.states.at(-1)?.selfCost;
  const { text, tools } = await agent.ask("What have I used this month?");
  const after = agent.states.at(-1)?.selfCost;
  expect(text.trim().length > 0, "empty reply");
  expect(tools.includes("getUsageSummary"), "the usage tool was not called");
  const ratio = repeatedWordRatio(text);
  expect(
    ratio <= MAX_REPEATED_WORD_RATIO,
    `reply repeats words (${Math.round(ratio * 100)}%)`
  );
  // Every figure must be copied from the tool result (rule G-1). Requiring
  // one exact, free-standing match also catches doubled digits.
  const figures = liveSummary.rows.map((row) => formatQuantity(row.quantity));
  const quoted = figures.filter((figure) => quotesFigure(text, figure));
  expect(
    quoted.length > 0,
    "the reply quotes none of the summary's figures exactly"
  );
  expect(before && after, "no meter state received");
  expect(after.todayNeurons > before.todayNeurons, "the turn was not metered");
  expect(
    after.unmeteredTurns === before.unmeteredTurns,
    "the turn was recorded as unmetered"
  );
  console.log(
    `  quoted ${quoted.length} of ${figures.length} figures exactly; meter: ${before.todayNeurons.toFixed(2)} → ${after.todayNeurons.toFixed(2)} neurons today`
  );
});

await check(
  "a bill explanation in test mode is grounded and labelled (UC-1, G-9)",
  async () => {
    expect(agent, "no agent session");
    await agent.call("setDataMode", ["test", SPIKE_SCENARIO]);
    try {
      const facts = await agent.call("explainBill");
      expect(facts.outcome === "explained", `outcome is ${facts.outcome}`);
      const impact = facts.findings[0].impact;
      // The model's wording varies from run to run. One retry is allowed, and
      // a failed attempt is printed, so the variation stays visible. The
      // reply holds fixture figures only, so it is safe to print.
      for (let attempt = 1; ; attempt++) {
        const { text, tools } = await agent.ask(
          "Why is my bill higher than usual?"
        );
        const problem =
          text.trim().length === 0
            ? "empty reply"
            : !tools.includes("explainBillChange")
              ? "the explain tool was not called"
              : !quotesFigure(text, facts.total)
                ? `the reply does not quote the total ${facts.total}`
                : !quotesFigure(text, impact)
                  ? `the reply does not quote the finding's ${impact}`
                  : !/test data/i.test(text)
                    ? "the reply does not say the figures are test data"
                    : null;
        if (problem === null) {
          console.log(
            `  quoted the total ${facts.total} and the finding ${impact}; labelled as test data (attempt ${attempt})`
          );
          break;
        }
        console.log(`  attempt ${attempt} failed: ${problem}`);
        console.log(`  reply was: ${text.slice(0, 500)}`);
        expect(attempt < EXPLAIN_ATTEMPTS, problem);
      }
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

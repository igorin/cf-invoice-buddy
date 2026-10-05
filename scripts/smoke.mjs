// Post-deploy smoke test (spec section 13). Runs against the live URL.
// Usage: node scripts/smoke.mjs <staging|production> <expected commit sha>
// Reads .secrets/smoke.env: SMOKE_URL_STAGING, SMOKE_URL_PRODUCTION,
// CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET.
import { ENVIRONMENTS, fail, readEnvFile } from "./lib.mjs";

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
const TURN_TIMEOUT_MS = 60_000;
const VERSION_WAIT_MS = 90_000;
const VERSION_POLL_MS = 3_000;
// A healthy reply almost never repeats a word back to back; the stream
// duplication defect (spec B8) repeats nearly all of them.
const MAX_REPEATED_WORD_RATIO = 0.2;

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

/** Sends one chat message and resolves with the reply text and meter states. */
function chatTurn(accountId) {
  const url = `${baseUrl.replace(/^http/, "ws")}/agents/invoice-buddy-agent/${accountId}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: accessHeaders });
    const states = [];
    let text = "";
    let finished = false;
    const timer = setTimeout(
      () => reject(new Error("timed out")),
      TURN_TIMEOUT_MS
    );
    const settle = () => {
      clearTimeout(timer);
      socket.close();
      resolve({ text, before: states[0], after: states.at(-1) });
    };
    socket.onerror = () => reject(new Error("WebSocket connection failed"));
    socket.onopen = () =>
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
                  parts: [
                    {
                      type: "text",
                      text: "In one sentence, what can you help me with?"
                    }
                  ]
                }
              ]
            })
          }
        })
      );
    socket.onmessage = (event) => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (frame.type === "cf_agent_state") {
        states.push(frame.state?.selfCost);
        if (finished) settle();
      }
      if (frame.type !== "cf_agent_use_chat_response") return;
      try {
        const part = JSON.parse(frame.body);
        if (part.type === "text-delta") text += part.delta ?? "";
      } catch {
        // Frames without a JSON body carry no text.
      }
      if (frame.done) {
        finished = true;
        // The meter state follows the last frame; allow it a moment.
        setTimeout(settle, 5_000);
      }
    };
  });
}

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
    {
      headers: accessHeaders
    }
  );
  expect(response.status === 403, `got HTTP ${response.status}`);
});

await check("one chat turn completes, undoubled, and is metered", async () => {
  expect(accountId, "no session");
  const { text, before, after } = await chatTurn(accountId);
  expect(text.trim().length > 0, "empty reply");
  const ratio = repeatedWordRatio(text);
  expect(
    ratio <= MAX_REPEATED_WORD_RATIO,
    `reply repeats words (${Math.round(ratio * 100)}%)`
  );
  expect(before && after, "no meter state received");
  expect(after.todayNeurons > before.todayNeurons, "the turn was not metered");
  expect(
    after.unmeteredTurns === before.unmeteredTurns,
    "the turn was recorded as unmetered"
  );
  console.log(
    `  meter: ${before.todayNeurons.toFixed(2)} → ${after.todayNeurons.toFixed(2)} neurons today`
  );
});

const failed = results.filter((result) => !result.ok);
console.log(
  `${results.length - failed.length}/${results.length} smoke checks passed on ${environment}`
);
process.exit(failed.length === 0 ? 0 : 1);

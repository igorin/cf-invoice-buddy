---
name: cloudflare-platform-notes
description: Observed behaviour of Cloudflare's platform as used by this project - Workers AI limits, pricing and stream quirks, AI Gateway caching, the Agents SDK, billing and GraphQL usage APIs, Access, Wrangler, deploys and testing. Use before designing, debugging or testing anything that calls Workers AI, AI Gateway, the Agents SDK, the billing or analytics APIs, or that deploys this Worker.
---

# Cloudflare platform notes

What this project learned about Cloudflare's platform between 2026-10-04 and 2026-10-07, on a new account on the Workers Free plan. The dated record behind each item is in `spec/low-level.md`, section 14.

Each item is marked:

- **Observed**: seen on the live platform, with the date.
- **Documented**: stated in Cloudflare's docs, not tested here.
- **Open**: not established. Do not design on it without a live check.

Versions in use when these were observed: `agents` 0.26.0, `@cloudflare/ai-chat` 0.12.1, `ai` 7.0.127, `workers-ai-provider` 4.0.0, `wrangler` 4.147, `@cloudflare/vite-plugin` 1.62.5, `@cloudflare/vitest-plugin` 1.3.x. Behaviour may differ on later versions; re-check before relying on an item after an upgrade.

Two habits that would have saved the most time: make one live call before designing on a documented behaviour, and read the raw output of the first live model call before trusting tests built on an assumed shape.

## Workers AI: allowance and limits

- **Documented**: 10,000 neurons a day are free, for the whole account, on both Workers Free and Workers Paid. Paid bills beyond that at $0.011 per 1,000 neurons. "All limits reset daily at 00:00 UTC."
- **Observed (2026-10-06)**: the reset is not that simple. After 12,557 neurons in the 04:00 UTC hour of 2026-10-05, calls were answered from 00:01 to 00:27 UTC the next day, then refused from about 00:30 until between 04:27 and 05:27 UTC, which is when the burst passed the 24-hour mark. That fits a trailing 24-hour window, apart from the calls answered just after midnight. Count budgets over the trailing 24 hours; it is never looser than the calendar day.
- **Open**: where exactly the limit sits. The trailing 24 hours held about 16,100 neurons at the last refusal and about 3,600 at the first answer.
- **Observed**: a refused call fails with error 4006, "you have used up your daily free allocation of 10,000 neurons". The docs' errors page lists the same message under code 3036 with HTTP 429. Match on the text, or on both codes.
- **Observed**: on the Free plan a refused call costs nothing and is not billed; the limit is a hard stop, not an overage.
- **Documented, and it matters**: there is no local model. The AI binding always runs remotely, "and will incur usage charges even in local development". `npm run dev`, tests that reach the binding, smoke tests and evaluations all draw on the same allowance.
- **Observed**: usage made outside the app (the dashboard playground, the `cf` or `wrangler` CLI) counts against the same allowance and is invisible to any per-instance budget. Read the account-wide figure before a planned burst.
- **Documented (changelog 2026-07-28)**: some large models return 403 (internal error 5035) on Workers Free. Llama 3.3 70B and Llama 3.1 8B were not on that list.

## Workers AI: pricing

Neurons per million tokens, from the pricing page:

| Model | Input | Output | Read on |
| --- | --- | --- | --- |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 26,668 | 204,805 | 2026-10-04 |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 4,119 | 34,868 | 2026-10-06 |
| `@cf/meta/llama-3.2-3b-instruct` | 4,625 | 30,475 | 2026-10-06 |
| `@cf/meta/llama-3.2-1b-instruct` | 2,457 | 18,252 | 2026-10-06 |
| `@cf/zai-org/glm-4.7-flash` | 5,500 | 36,400 | 2026-10-06 |
| `@cf/google/gemma-4-26b-a4b-it` | 9,091 | 27,273 | 2026-10-06 |

- **Observed**: token counts times these rates equal the neurons Cloudflare reports. 343 input and 31 output tokens on Llama 3.3 came to 15.50 neurons in analytics and 15.496 by calculation.
- **Observed**: typical costs in this app on Llama 3.3. A one-question turn with one tool call is about 112 neurons. A short probe turn is about 160. A full evaluation run of ten cases is roughly 2,500.
- **Observed**: most of a turn's input tokens are tool results, not the system prompt. Cutting 40% of the prompt and tool descriptions saved about 350 tokens, 9 neurons, a step.
- **Open**: whether the 8B model calls tools reliably. Not tried.

## Workers AI: Llama 3.3 and its stream

- **Documented**: `@cf/meta/llama-3.3-70b-instruct-fp8-fast` supports function calling and has a 24,000-token context window. Keep turns short and prune old tool results.
- **Observed (2026-10-05), a real defect**: the stream carries each piece of output twice, and `workers-ai-provider` (3.3.1 and 4.0.0) emits both, so replies come out doubled. Three forms were found, one at a time:
  1. Text: in `response` and in `choices[0].delta.content`.
  2. Numbers: a numeric token is a JSON number in `response` and text in the delta, so "311" became "311311". Compare numerically.
  3. Tool calls: in top-level `tool_calls` and in `choices[0].delta.tool_calls`, which doubled the arguments and broke every tool call.
  The fix here is `src/domain/dedupe-stream.ts`, a proxy around the binding's `run`. Remove it once the provider or the stream is fixed, and keep a smoke check for doubled words.
- **Observed**: the usage chunk (`prompt_tokens`, `completion_tokens`) passes through a stream wrapper untouched if the wrapper only edits chunks whose duplicate it removes. The provider reports missing usage as zero tokens, so treat zero input tokens as "unmetered", not as free.
- **Observed**: with a strict tool input schema the model retried a rejected call until the step limit, each retry with a longer context. That, plus the broken tool calls above, used 12,939 neurons in a day. Use loose schemas with validation in code, a loop guard, and a low step limit (five here).
- **Observed**: the model fills optional tool parameters with words or amounts from the question ("usual", "$150") and invents dates when the prompt does not give today's.
- **Observed**: in 32 evaluation turns it made up one link and one figure. Do not rely on prompting alone for grounding; check replies in code.

## AI Gateway

- **Observed (2026-10-07)**: a Workers AI call goes through a gateway by passing `gateway: { id, cacheTtl }` in the third argument of `env.AI.run`. With `workers-ai-provider`, `createWorkersAI({ binding, gateway })` does this. Streaming and tool calls work through it.
- **Observed (2026-10-07)**: a cache hit for a Workers AI model uses no neurons. Two identical smoke turns 76 seconds apart showed 112 neurons in analytics, not 224; two later ones added none.
- **Observed (2026-10-07)**: a streamed, two-call turn with a tool call is cached and replays as a stream the app reads normally.
- **Observed (2026-10-07)**: the cache status reaches Worker code. Call `env.AI.run(model, inputs, { ...options, returnRawResponse: true })` to get a `Response`, read the `cf-aig-cache-status` header (`HIT` on a hit), and use `response.body` as the stream. With this option a failed call may come back as a non-OK response instead of throwing, so check `ok` and throw yourself.
- **Observed (2026-10-07)**: a call that misses the cache does not report `HIT` and its tokens are billed: a first smoke turn after a prompt change was metered at 136 neurons with no cached calls, and the identical turn that followed was two hits. The header's exact value on a miss was not recorded (`MISS` is documented). Treat anything but `HIT` as billed.
- **Documented**: a hit needs an exact match of provider, endpoint, model, auth and the full request body. A prompt containing today's date therefore only hits within the same day and the same data. Minimum TTL 60 seconds, maximum one month. Caching is off by default on a gateway.
- **Observed**: the gateway used here was created in the dashboard, and requests sent `cacheTtl`. **Open**: whether the per-request TTL alone turns caching on, or the gateway's own caching setting is needed too.
- **Observed**: the token usage reported for a cached reply is the original call's, so a meter built on tokens counts a cached call unless it checks the header.
- **Documented**: the Free plan allows 10 gateways. Gateways also offer rate limits, spend limits and per-request logs; `env.AI.aiGatewayLogId` and `env.AI.gateway(id).getLog(logId)` return a log with a `cached` field. Not used here.
- **Documented**: the gateway id `default` is created automatically on first use.
- Do not cache where repeats are deliberate, such as evaluation runs that ask the same question three times.

## Agents SDK and AI SDK

- **Observed**: `AIChatAgent.onChatMessage` may return a plain `Response` for a fixed reply with no model call.
- **Observed**: `persistMessages` upserts the messages given and broadcasts that same list. Pass the full list, `[...this.messages, notice]`.
- **Observed**: `onChatResponse` fires after the turn's message is stored, which is too late to stop text reaching the browser. To hold text until it is checked, wrap `result.toUIMessageStream()` and return it with `createUIMessageStreamResponse`. Forward tool chunks at once, buffer `text-start`/`text-delta`/`text-end`, and release the text before `finish`. The stored message is built from the same stream.
- **Observed**: UI stream chunk types include `start`, `start-step`, `tool-input-start`, `tool-input-available` (`toolCallId`, `toolName`, `input`), `tool-output-available` (`toolCallId`, `output`, optional `preliminary`), `text-start`, `text-delta`, `text-end`, `finish-step`, `finish`, `error` (`errorText`).
- **Observed**: `streamText`'s `onFinish` gives `steps`, each with `usage`, and `totalUsage`. One step is one model call unless a call is retried.
- **Observed**: `chatRecovery = true` is a type error on `@cloudflare/ai-chat` 0.12. `chatStreamStallTimeoutMs` aborts a silent model stream.
- **Observed**: a tool with `needsApproval: true` does nothing until the owner approves, including when the model starts it.
- **Observed**: the mock model for tests is `MockLanguageModelV4` from `ai/test` on `ai` 7 (it was V3 on `ai` 6), with `simulateReadableStream`.
- **Observed**: `@callable()` decorators need the `agents()` Vite plugin in the Vitest project, or they fail to parse.
- **Observed**: the Vite build keeps the agent's class name, which Durable Object bindings depend on.
- **Observed**: `compatibility_date` must not be newer than the installed `workerd` supports, or local runs fail.
- **Observed**: the starter needs `@ai-sdk/react` installed explicitly. Upgrading the stack through `npm install <pkg>` hit resolver conflicts; setting versions in `package.json` and reinstalling cleanly worked.
- **Observed (2026-10-07)**: `agents` 0.26.0 pins `@modelcontextprotocol/sdk` and `client` versions with a published advisory, and `miniflare` pins an affected `sharp`. Neither parent had a fixed release; npm `overrides` cleared the audit with all tests passing.

## Workflows

- **Documented**: Workflows run on Workers Free. Limits there: 1,024 steps per instance, 100,000 executions a day shared with the Workers request limit, 100 concurrent running instances (waiting ones do not count), state of completed instances kept for 3 days, instance ids up to 100 characters matching `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$`. Keep anything you need for longer in your own storage.
- **Observed (2026-10-07, local test runtime)**: an `AgentWorkflow` started with `this.runWorkflow(binding, params, { id })` runs its `step.do` steps, calls the agent's public methods through `this.agent`, waits in `waitForApproval`, and resumes after `approveWorkflow` or throws after `rejectWorkflow`. The wrangler entry is `"workflows": [{ "name", "binding", "class_name" }]`, per environment, and the class must be exported from the Worker's entry file.
- **Observed**: a rejection is recognised by `error.name === "WorkflowRejectedError"`; a timeout of the wait is a different error. The SDK also reports a rejection to the agent as a workflow error, so `onWorkflowError` runs after `rejectWorkflow`: do not let it overwrite a rejection.
- **Observed**: instance ids are shared by every agent instance that uses the same Workflow, so an id built only from the agent's own data can collide. Use a random part.
- **Observed**: `@callable()` methods declared on a base class are inherited by the agent class that extends it.
- **Observed**: in tests, `introspectWorkflow(env.BINDING)` from `cloudflare:test` captures instances; `await introspector.get()` (it is asynchronous) returns them; `waitForStepResult({ name })` and `waitForStatus("complete")` wait; `modifyAll((m) => m.forceEventTimeout({ name: "wait-for-approval" }))` forces the approval wait to time out. Use `await using` so the introspector is disposed. A forced timeout logs an uncaught `WorkflowTimeoutError`; the test still passes.
- **Documented**: `pauseWorkflow`, `resumeWorkflow`, `terminateWorkflow` and `restartWorkflow` do not work under local development.

## Durable Objects and storage

- **Observed**: `ctx.storage.sql.exec` works as documented for a SQLite-backed agent. Keep migrations additive and idempotent (`CREATE TABLE IF NOT EXISTS`). SQLite has no `ADD COLUMN IF NOT EXISTS`, so a re-run of an `ALTER TABLE` migration fails; add a table instead.
- **Observed**: state saved by an earlier version lacks newer fields. Merge defaults on start.
- **Observed**: a cron schedule set in `onStart` (`this.schedule(cron, method)`) is idempotent.
- **Observed**: a smoke test that writes into the owner's agent instance leaves its messages in the owner's conversation. Use a separate instance name and clear its history each run; a growing history also raises the cost of every turn.

## Billing and usage APIs

- **Observed (2026-10-05)**: an account API token with `Billing: Read` and `Account Analytics: Read` gets 200 from `billable-usage`, `billable-usage/info`, `billing/history`, `subscriptions` and `billing/credits`. A user's `cf` or `wrangler` login does not include billing access and cannot be used by a deployed Worker.
- **Observed**: on a new account with a $0 bill these are empty. `info` reports `covered: false`, there are no invoices, and the billing profile returns 404. The shape of real charge records could not be observed. **Open**: whether usage records are daily, and the service name Workers AI appears under.
- **Observed**: the newer usage endpoint (`/accounts/{id}/billable/usage`, v2, alpha) returns 403 `insufficient_permissions` with `Billing: Read`. Access is granted by Cloudflare, not by a token setting.
- **Observed**: no public API submits a credit request. Billing cases are opened in the dashboard (Support, Billing, Create a Case), which is open to Free plans.
- **Observed**: the GraphQL Analytics API (`https://api.cloudflare.com/client/v4/graphql`) returns real per-product usage for an account with a $0 bill. Datasets used, under `viewer.accounts(filter: { accountTag })`:

  | Dataset | Fields used |
  | --- | --- |
  | `aiInferenceAdaptiveGroups` | `sum { totalNeurons }`; dimensions `date`, `datetimeHour`, `modelId` |
  | `workersInvocationsAdaptive` | request counts; has a script name dimension |
  | `durableObjectsInvocationsAdaptiveGroups` | request counts |
  | `durableObjectsPeriodicGroups` | duration in GB-seconds, `rowsRead`, `rowsWritten` |
  | `durableObjectsSqlStorageGroups` | storage |
  | `workflowsAdaptiveGroups` | `stepCount` |

  Filter by `date_geq`/`date_leq` with `Date!` variables, or `datetime_geq`/`datetime_leq` with `Time!`. Order hourly rows with `orderBy: [datetimeHour_ASC]`.
- **Observed**: neuron analytics lag by a few minutes. A turn showed partially after 2 minutes and fully after about 5. Wait before concluding a call was free.
- **Observed**: free-plan allowances are daily, paid ones are per billing period. An account with no billing cycle has no anchor day; this app uses the calendar month.

## Cloudflare docs MCP server

- **Observed (2026-10-06)**: `https://docs.mcp.cloudflare.com/mcp` needs no credentials and no session. One JSON-RPC `tools/call` request for `search_cloudflare_documentation` with `{ query }` returns a server-sent reply whose `result.structuredContent.results` is a list of `{ similarity, id, url, title, text }`.
- A direct request avoids keeping an MCP connection alive across the agent's sleep and wake, which `addMcpServer` would need.
- As a safeguard, keep only results whose URL is on `developers.cloudflare.com`, and cut the text to a short excerpt before giving it to the model.

## Cloudflare Access

- **Documented, and it decided the design**: Worker-level Access policies do not support WebSocket connections and return 403 on upgrade. Use a hostname-based self-hosted Access application on the Worker's `workers.dev` hostname, one per environment.
- **Observed**: the signed-in identity arrives as a JWT in `Cf-Access-Jwt-Assertion`; verify it with `jose` against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and the application's AUD.
- **Observed**: service tokens authenticate with the `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, which is how scripts reach a protected Worker.
- **Observed**: the first deploy of an environment has to create the hostname before an Access application can protect it. Deploy once with a placeholder AUD so every request is refused, then create the application.
- **Observed**: local development that uses remote bindings reaches the model through a protected hostname, so `npm run dev` needs an Access sign-in or a service token in `CLOUDFLARE_ACCESS_CLIENT_ID` and `CLOUDFLARE_ACCESS_CLIENT_SECRET`.
- Set `preview_urls: false`, or each preview URL is a second, unprotected door.

## Wrangler, builds and deploys

- **Observed**: `wrangler deploy --secrets-file <file>` uploads code and secrets in one step, including on the first deploy.
- **Observed**: with the Vite plugin, the environment is chosen at build time by `CLOUDFLARE_ENV`; the build writes a resolved config into `dist`, and `wrangler deploy` then uses it. A `--env` flag on a later dry run does not change what the build resolved.
- **Observed**: `wrangler tail` works with the ordinary login and shows failed invocations, exceptions and error-level logs during a smoke run. Its events contain request headers; never print them.
- **Observed**: rolling back a Worker version does not roll back Durable Object storage. A schema change must stay compatible with the previous version. The rollback drills are in `spec/deployments.md`.
- **Observed**: `wrangler types env.d.ts` generates binding types from the local config. Run it after changing bindings or vars.
- **Observed**: `npx wrangler deploy --dry-run` needs no login and is safe in CI.
- **Documented**: the docs now prefer a declarative `exports` field over the `migrations` array for Durable Objects in new Workers; both are supported.
- **Observed**: Workers Free ran every turn this app makes, including turns with tool calls; peak CPU on a smoke run was 161 to 266 ms.
- This project has a Wrangler configuration (`wrangler.jsonc`, git-ignored, copied from `wrangler.example.jsonc`), so use `wrangler` for it, not the `cf` CLI.

## Testing on Cloudflare

- **Observed**: `@cloudflare/vitest-plugin` (formerly `@cloudflare/vitest-pool-workers`) runs tests inside the Workers runtime with `cloudflareTest`, `runInDurableObject` and `getAgentByName`. Set `remoteBindings: false` and give fixed test values through `miniflare.bindings`, so tests need no login and no `.dev.vars`.
- **Observed**: coverage must use the Istanbul provider. Measuring the same files from two Vitest projects in one run made the merged figures depend on run order; run each scope separately.
- **Observed**: `import.meta.glob` runs without error in the Workers test pool, as a way to load fixture files where `fs` is not available. It has only been run against an empty folder so far.
- **Observed**: the model can be replaced below the provider. A fake binding whose `run` returns a recorded stream, passed to `createWorkersAI({ binding })`, replays a turn through the real provider, the stream wrappers and the agent with no model call (`src/domain/model-recording.ts`). **Open**: whether recordings of real turns replay cleanly; none has been taken yet.
- **Observed**: fixture data built relative to today makes a recorded reply stale the next day. Pin the clock to the recording day on replay.
- A three-tier split keeps live calls rare: a scripted model on every commit, replayed recordings on every pull request, the live model only before a release.

## Not Cloudflare, but it cost a day

- **Observed (2026-10-05)**: a repository under `~/Documents` on a Mac with iCloud "Desktop & Documents Folders" fills with conflict copies named like `file 2.ts`, including inside `.git` and `node_modules`, which broke `git rev-list` and CI. Keep repositories outside synced folders and review staged files before every commit.

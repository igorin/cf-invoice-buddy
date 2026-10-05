# Invoice Buddy: low-level spec

| | |
| --- | --- |
| Status | Draft for review |
| Last updated | 2026-10-04 |
| Implements | [high-level.md](high-level.md), using the defaults in its open questions |

This document says how to build what the high-level spec requires. It follows Cloudflare's [chat agent guide](https://developers.cloudflare.com/agents/examples/chat-agent/) and the `cloudflare/agents-starter` template. Section 14 lists what was checked against the Cloudflare docs and what could not be.

## 1. Project setup

The starter's files are copied into the repository, keeping the existing `LICENSE`, `README.md`, `AGENTS.md` and `.gitignore`. The starter's own CI workflows are not copied.

```sh
npx create-cloudflare@latest --template cloudflare/agents-starter
npm install
npm install -D vitest@^4.1.0 @cloudflare/vitest-plugin @vitest/coverage-istanbul @playwright/test
```

The repository first held a Cloudflare Workflows "hello world" scaffold. It was replaced by the starter on 2026-10-05, since the chat UI, build and agent class all come from the starter.

The starter pins older versions than the current releases. The project runs on the upgraded stack below, decided 2026-10-05:

| Package | Starter | Project |
| --- | --- | --- |
| `ai` | 6.0 | 7.0.127 |
| `workers-ai-provider` | 3.2 | 4.0.0 |
| `agents` | 0.17 | 0.26.0 |
| `@cloudflare/ai-chat` | 0.9 | 0.12.1 |
| `@ai-sdk/react` | 3.0 | 4.0 (now required by the build) |
| `wrangler` | 4.113 | 4.147.0 |
| `@cloudflare/vite-plugin` | 1.46 | 1.62.5 |
| `vite` | 8.1 | 8.3.2 |
| `vitest` | not included | 4.1.11, the major the Cloudflare Vitest plugin requires |
| `typescript` | 6.0 | 6.0.3, unchanged |

`chatRecovery = true` from the starter no longer type-checks on `@cloudflare/ai-chat` 0.12 and is omitted; the SDK default applies.

### Changes to the starter

| Starter | This project | Reason |
| --- | --- | --- |
| `ChatAgent` | `InvoiceBuddyAgent` | Named for its job. Binding and migration use the new name from `v1`. |
| Model `@cf/moonshotai/kimi-k2.7-code` | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Product decision. |
| Demo tools (weather, timezone, calculate, scheduling) | Removed | Replaced by the tools in section 5. |
| `addServer` / `removeServer` callables | Removed | The owner must not be able to attach arbitrary MCP servers to an agent that holds billing data. |
| `stopWhen: stepCountIs(20)` | `stepCountIs(8)` | 24,000-token context. |
| No tests | Vitest, Playwright, evals | NFR-T1 to NFR-T6. The starter's `package.json` ships no test runner, although the Cloudflare testing page says it does. |

### `wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cf-invoice-buddy",
  "main": "src/server.ts",
  "compatibility_date": "2026-07-21", // must not be newer than the installed Workers runtime supports
  "compatibility_flags": ["nodejs_compat"],
  "ai": { "binding": "AI", "remote": true },
  "assets": {
    "directory": "./public",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/agents/*", "/api/*"]
  },
  "durable_objects": {
    "bindings": [{ "name": "InvoiceBuddyAgent", "class_name": "InvoiceBuddyAgent" }]
  },
  "workflows": [
    { "name": "invoice-close", "binding": "INVOICE_CLOSE_WORKFLOW", "class_name": "InvoiceCloseWorkflow" }
  ],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["InvoiceBuddyAgent"] }],
  "observability": { "enabled": true },
  "preview_urls": false,
  "vars": { "USAGE_SOURCE": "graphql-analytics,billable-usage-v1,billing-history", "DAILY_NEURON_BUDGET": "10000" },
  "env": {
    "staging": { "name": "cf-invoice-buddy-staging" /* own bindings and workflow name */ },
    "production": { "name": "cf-invoice-buddy" /* same sources; own bindings */ }
  }
}
```

The top level is local development. `staging` and `production` are Cloudflare environments, selected at build time with `CLOUDFLARE_ENV` because the project builds with the Cloudflare Vite plugin. Bindings and `vars` are not inherited by environments, so each environment repeats `ai`, `durable_objects`, `workflows` and `vars`. The staging workflow is named `invoice-close-staging` so the two environments do not share instances. Each environment has its own Durable Object namespace and therefore its own data and its own meter.

Secrets, set per environment with `wrangler secret put`: `CF_ACCOUNT_ID`, `CF_API_TOKEN` (billing read only), `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`. Local values go in `.dev.vars`, which is git-ignored. Env types come from `npm run types` (`wrangler types`); they are not written by hand.

Rules from the Cloudflare docs that apply here:

- Do not enable `experimentalDecorators`; it breaks `@callable`.
- Never edit a deployed migration; add a new tag.
- Workflow callbacks find the agent through its class name, so the build must preserve class names. Integration test `workflow-callback.test.ts` proves it against the built output.
- Workflows reach the agent by name, so the agent is always addressed by name, never by raw Durable Object ID.

## 2. Source layout

```
spec/                     high-level.md, low-level.md
src/
  server.ts               Worker entry: auth, routing; exports agent and workflow
  agent.ts                InvoiceBuddyAgent
  prompt.ts               system prompt
  tools/                  one file per tool (section 5)
  workflows/              invoice-close.ts
  domain/                 pure code, no Cloudflare imports
    money.ts              Micros type and arithmetic
    periods.ts            billing period maths
    breakdown.ts          by product, by day, deltas
    detectors/            one file per detector (section 6)
    reconcile.ts          snapshot vs. invoice
    grounding.ts          response checker (section 7)
    credit-draft.ts       draft template and submission instructions
    self-cost.ts          token-to-neuron-to-dollar conversion, price constants, budget check
    usage-summary.ts      per-product summary from usage rows and the allowance table
    allowances.ts         included amounts per plan and metric, with source and date checked
  ports/                  usage-source.ts, docs-search.ts (interfaces)
  adapters/               fixture and API implementations of the ports (usage sources: section 4)
  db/                     schema.ts (migrations), queries.ts, row schemas
  auth.ts                 Access JWT verification
  app.tsx, components/    chat UI (starter, plus the cards in section 9)
test/
  unit/  integration/  e2e/  fixtures/
evals/                    grounding and capability cases (section 10)
scripts/smoke.ts          post-deploy smoke test (section 13)
.github/workflows/        ci.yml, deploy.yml
spec/deployments.md       deployment record (section 13)
```

`domain/` imports nothing from Cloudflare or the AI SDK. That keeps it testable without the Workers runtime and is what the 95% coverage bar (NFR-T3) applies to.

## 3. Worker entry and authentication

`server.ts` handles four kinds of request:

| Route | Behaviour |
| --- | --- |
| `GET /api/session` | Verifies the Access JWT. Returns `{ accountId }` so the client knows which agent instance to open. |
| `GET /api/version` | Behind Access like everything else. Returns the commit SHA baked in at build time, the environment name, and whether every required secret and variable is present (names only, never values). |
| `/agents/*` | `routeAgentRequest(request, env, { onBeforeConnect, onBeforeRequest })`. Both hooks verify the Access JWT and reject with 403 any instance name other than `env.CF_ACCOUNT_ID`. |
| anything else | Static assets. |

`auth.ts` verifies the `Cf-Access-Jwt-Assertion` header against the team's public keys and the `ACCESS_AUD` audience. An `AUTH_MODE=dev` bypass exists for local development and is refused when the request hostname is not `localhost`.

Environment variables and secrets are parsed with one Zod schema when the Worker first handles a request. A missing or malformed value fails every request with a 500 and a log line naming the variable, so a misconfigured deployment cannot pass the smoke test.

## 4. Data model

All tables live in the agent's SQLite and are created by numbered migrations in `db/schema.ts`, applied in `onStart` and recorded in `schema_migrations`. Chat messages and workflow tracking are stored by the SDK in its own tables; this project does not touch them directly.

Money is stored as integer micro-dollars (`*_micros`, 1 USD = 1,000,000). Timestamps are ISO 8601 UTC text. Every query uses the `this.sql` tagged template, which parameterizes values. Rows are parsed with a Zod schema on the way out.

| Table | Columns | Notes |
| --- | --- | --- |
| `usage_charges` | `charge_start`, `charge_end`, `billing_period_start`, `service`, `service_family`, `zone_id`, `zone_name`, `consumed_qty`, `consumed_unit`, `pricing_qty`, `pricing_unit`, `cost_micros`, `currency`, `description`, `synced_at` | One row per usage record, including usage inside free allowances. Primary key (`charge_start`, `service`, `metric`, `zone_id`). Upserted on sync. A `metric` column names the billable metric and a `source` column names the adapter that supplied the row. `cost_micros` is null when the source gives no cost; null is never read as zero. |
| `usage_source_status` | `service`, `source`, `last_success_at`, `last_error` | Per product, so one unreadable product is shown as unavailable without hiding the rest (UC-9). |
| `invoices` | `invoice_id`, `period_start`, `period_end`, `amount_micros`, `currency`, `status`, `issued_at` | From billing history. |
| `sync_state` | `source`, `last_success_at`, `last_error`, `covered_from`, `covered_to` | Drives rule G-6. |
| `credit_requests` | `id`, `period_start`, `service`, `amount_micros`, `owner_reason`, `draft`, `evidence_json`, `state`, `reported_amount_micros`, `reported_note`, `created_at`, `updated_at` | One current draft per (`period_start`, `service`); replacing it sets the old row to `superseded`. `state` after `drafted` is owner-reported. |
| `invoice_closes` | `period_start`, `workflow_id`, `state`, `snapshot_total_micros`, `invoice_total_micros`, `variance_micros`, `findings_json`, `closed_at` | Primary key `period_start`. |
| `usage_snapshots` | `period_start`, then the `usage_charges` columns | Frozen copy written by the close. Never updated. |
| `audit_log` | `id`, `at`, `actor`, `action`, `subject_id`, `detail_json` | Insert only. `actor` is `owner`, `agent` or `workflow`. |
| `self_usage` | `id`, `at`, `request_id`, `model`, `steps`, `input_tokens`, `output_tokens`, `neurons`, `cost_micros`, `metered` | One row per chat turn. `metered` is 0 when the provider returned no token counts; the token, neuron and cost columns are then null. Insert only. |
| `self_activity_daily` | `day`, `chat_turns`, `incoming_messages`, `scheduled_runs`, `workflow_steps`, `refused_turns` | Counters behind the estimated, non-model part of the cost report. |

Credit request states: `drafted`, then optionally `reported_submitted`, `reported_approved`, `reported_partially_approved` or `reported_denied` when the owner says so, or `superseded` when replaced.

Invoice close states: `snapshotting → rating → checking → awaiting_approval → closed`, with `rejected`, `expired` and `failed` as terminal alternatives that leave the period open.

### Live and test data

Implements UC-10 and G-9. `usage_charges`, `invoices`, `credit_requests`, `invoice_closes`, `usage_snapshots` and `usage_source_status` each carry a `dataset` column, `live` or `test`, which is part of every primary and unique key. Every query in `db/queries.ts` takes the dataset as a required argument; there is no default. `audit_log` records the dataset of each entry. `self_usage` has no dataset: the meter is always real.

The current mode is `state.dataMode`: `{ dataset: "live" }` or `{ dataset: "test", scenario }`. It is persisted with the agent state and is the single place tools read the dataset from. A tool never accepts the dataset as model input.

Scenarios are the fixture accounts in `test/fixtures/scenarios/`, also bundled with the Worker. They are the same files the tests and evals use. Entering test mode with a scenario replaces the `test` rows with that scenario's data, with dates shifted so the scenario's last period is the current one. `syncUsage` writes only `live` rows.

### Usage sources

The `UsageSource` port returns usage records with an optional cost. `USAGE_SOURCE` is a comma-separated list of live sources; they are merged per product, and the first that supplies a field wins. Fixture data is not a live source: it is reached only through test mode.

| Adapter | Supplies | Status |
| --- | --- | --- |
| `fixture` | Quantities, costs and invoices from scenario files | Feeds the `test` dataset only (UC-10). Never merged with live sources. |
| `graphql-analytics` | Daily quantities per product from the Workers AI, Workers, Durable Objects and Workflows datasets, including usage inside free allowances. No cost. | Primary source for quantities. Proven on this account with real data (B7). |
| `billable-usage-v1` | Cost and priced quantity for pay-as-you-go charges, plus `info`, which says whether the account is covered. | Source for cost. Reachable with `Billing Read` (B1); empty here because the account has no usage-based subscription. |
| `billing-history` | Issued invoices. | Reachable; empty here. |
| `billable-usage-v2` | Daily quantity per billable metric, including free-allowance usage. | Not used in v1. Restricted; 403 even with `Billing Read`. |
| `self-meter` | Workers AI neurons and cost for the assistant's own calls, from `self_usage`. | Always available. Labelled as the assistant's share, not the account total. |

The billed amount is stated only from billing sources. When `info` reports the account as not covered, there are no subscriptions and no invoices, the panel says "No charges: this account has no usage-based subscription and no invoices" and shows quantities only. If the billing sources cannot be read at all, amounts show as unavailable.

GraphQL queries filter by account and date range and group by `date` plus the product's own dimension (model for Workers AI, script for Workers). Each dataset is one query per sync. The mapping from dataset fields to the summary's metrics and allowances lives in one file, so adding a product is one entry.

### Agent state

`this.state` is synced to the browser, so it stays small and holds nothing the UI does not show:

```ts
type AgentState = {
  pendingApprovals: ReadonlyArray<{
    workflowId: string;
    kind: "invoice_close";
    title: string;
    expiresAt: string;
  }>;
  creditRequests: ReadonlyArray<{ id: string; service: string; amountMicros: number; state: CreditRequestState }>;
  lastSyncAt: string | null;
  dataMode: { dataset: "live" } | { dataset: "test"; scenario: string };
  selfCost: { monthCostMicros: number; todayNeurons: number; dailyBudgetNeurons: number; unmeteredTurns: number };
};
```

## 5. Tools

Tools are defined with the AI SDK `tool()` helper and Zod input schemas. All run on the server. None has an effect outside the agent's own database. `startInvoiceClose` starts a workflow that stops at an approval gate.

Every result is capped at about 1,500 tokens: top eight products, and daily series only for the three largest movers. Amounts are returned both as micros and as a formatted string, so the model copies the string and never formats or computes.

| Tool | Input | Returns |
| --- | --- | --- |
| `getInvoiceSummary` | `period?` | Invoice total, status, month-to-date flag, last sync time, data gaps. |
| `explainBillChange` | `period?`, `baselinePeriod?` | Total and baseline, delta per product, daily series for top movers, `findings[]` (section 6), `dataGaps[]`, and `assistantShare` for the Workers AI line (section 12). Empty `findings` carries `explanation: "none_found"`. |
| `setDataMode` | `dataset: "live" \| "test"`, `scenario?` | Declared with `needsApproval: true`, so the SDK pauses and the owner confirms in the UI before it runs. Lists the scenarios when `scenario` is missing. |
| `getUsageSummary` | `period?` | One row per product and metric: quantity, unit, included allowance and share used (when the allowance table has an entry), billed amount or `unavailable`, and per-product availability. Also the period covered and the last sync time. Works with no invoice and a $0 bill. |
| `getUsageBreakdown` | `period`, `groupBy: "product" \| "day" \| "zone"`, `service?` | Aggregated rows. |
| `searchCloudflareDocs` | `query` | Up to three results: `title`, `url`, `excerpt`. Backed by the docs MCP server. |
| `getAssistantCost` | `period?`, `groupBy?: "day"` | Metered model cost, neurons, tokens and turns; unmetered turn count; estimated Durable Object and Workflow activity against included amounts; the price constants' source and date; the three limit statements from UC-8. |
| `comparePlans` | `period` | Cost of the period's usage per plan, with price source and effective date. |
| `draftCreditRequest` | `period`, `service`, `ownerReason`, `replaceExisting?` | The draft text, its evidence, the computed amount, and the fixed submission instructions with their link. Returns the existing draft instead when one exists and `replaceExisting` is not set. |
| `getCreditRequests` | `id?`, `state?` | Stored drafts with amounts, dates and any owner-reported outcome, flagged as owner-reported. |
| `recordCreditOutcome` | `id`, `outcome`, `amount?`, `note?` | Stores what the owner says happened to a request. |
| `startInvoiceClose` | `period` | Close ID, or the existing close for that period. |
| `getInvoiceCloseStatus` | `period` | State, totals, variance, findings. |

There is no tool that approves, rejects or finalizes a close (NFR-S3), and none that submits anything to Cloudflare.

Every data tool result carries `dataset` and, in test mode, `scenario`. The system prompt receives the current mode each turn and requires the test-data label on any figure from a `test` result. The grounding checker (section 7) fails a response that states figures from a `test` result without the label, or that draws on results from both datasets.

**Credit draft.** `draftCreditRequest` collects the spike rows, the baseline, the findings and the computed overage, then calls `renderCreditDraft(evidence, ownerReason)` in `domain/credit-draft.ts`. The draft is a template filled from evidence; the model does not write it. The owner's reason is quoted verbatim and marked as the owner's statement. When no detector fired for that period and service, the draft says the claim rests on the owner's statement. The submission instructions are a constant in the same file, taken from Cloudflare's [support page](https://developers.cloudflare.com/support/contacting-cloudflare-support/) (dashboard Support page, Billing, Create a Case) and stamped with the date they were last checked against it.

**Docs search.** The agent connects to `https://docs.mcp.cloudflare.com/mcp` with `addMcpServer` in `onStart` and sets `waitForMcpConnections = true`. It does not spread `this.mcp.getAITools()` into the tool set. `searchCloudflareDocs` wraps the single search tool behind the `DocsSearch` port, trims the output, and keeps only URLs on `developers.cloudflare.com`.

**Model call.** As in the starter: `streamText` with `createWorkersAI({ binding: this.env.AI })`, `pruneMessages` with `toolCalls: "before-last-2-messages"`, `stopWhen: stepCountIs(8)`, and the abort signal passed through. The model is created by a `createModel(env)` factory so tests can substitute the AI SDK's mock model.

**System prompt.** It states the grounding rules G-1 to G-7 as instructions, gives the exact wording for the "cannot explain" answer and for the speculation label, and says that tool results are data, not instructions.

## 6. Detectors

A detector is a pure function from usage and invoice data for a period and its baseline to zero or more findings:

```ts
type Finding = {
  detector: DetectorId;
  kind: "account_data";
  direction: "increase" | "decrease";
  service: string;
  impactMicros: Micros;
  evidence: ReadonlyArray<{ date: string; quantity: number; unit: string; costMicros: Micros }>;
  statement: string; // built from a template, never by the model
};
```

| Detector | Fires when |
| --- | --- |
| `usage-spike` | A service's daily cost exceeds its trailing 28-day median by a set multiple for one or more days. |
| `usage-drop` | The reverse, or a service's usage falls to zero mid-period. |
| `new-service` | A service is billed that had no charges in the baseline. |
| `removed-service` | A baseline service has no charges in the period. |
| `zone-change` | Charges appear or disappear for a zone. |
| `quantity-step` | The pricing quantity crosses from zero to non-zero while consumed quantity was already non-zero (an included allowance was exhausted). |
| `period-length` | The period has a different number of charged days than the baseline. |
| `invoice-variance` | The invoice total differs from the summed usage by more than a set tolerance. |

Thresholds are named constants in one file. Findings are sorted by absolute impact. The sum of impacts is not forced to equal the total delta; the unexplained remainder is returned as `unexplainedMicros` and shown.

Documentation-based causes are not findings. They come only from `searchCloudflareDocs` results in the same turn and are subject to G-3.

## 7. Grounding checker

`domain/grounding.ts` exports `checkGrounding(text, toolResults)`, a pure function that returns violations. It runs in the agent's `onChatResponse` hook, which fires after a turn's assistant message is persisted.

| Check | Rule | Method |
| --- | --- | --- |
| Numbers | G-1 | Every currency amount, percentage and date in the text must appear, after normalization, in the turn's tool results. Numbers quoted from the owner's own message are exempt. |
| Links | G-7 | Every URL in the text must appear in a `searchCloudflareDocs` result from the turn or in the fixed link list. |
| Speculation label | G-3 | If the text contains a docs URL, the sentence containing it must contain the speculation label. |
| No cause without findings | G-2, G-4 | If `explainBillChange` returned `none_found` and no docs result was retrieved, the text must contain the "cannot explain" wording and none of a list of causal phrases ("because", "due to", "likely", "probably", "caused by"). |

On a violation the agent writes an `audit_log` row and appends a fixed notice to the chat with `persistMessages`, passing the full message list: "Part of the previous answer could not be verified against your account data. Rely on the breakdown card." The streamed text has already reached the browser, so the notice corrects it; it is not silently rewritten.

The phrase list in the last check is a heuristic and will miss paraphrases. The evals in section 10 are the stronger test of G-2 and G-4.

## 8. Agent methods and workflow

### Agent methods

| Method | Called by | Does |
| --- | --- | --- |
| `onStart` | SDK | Runs migrations, connects the docs MCP server, registers the 6-hourly `syncUsage` cron (cron schedules are idempotent). |
| `syncUsage` | Schedule; tools when data is older than 6 hours | Pulls usage and invoices through the `UsageSource` port, upserts, updates `sync_state`. A failure records the error and leaves existing data. |
| `setDataMode(dataset, scenario?)` | Browser, `@callable`, from the mode switch; also the approved `setDataMode` tool | Validates the scenario name against the bundled list, loads the scenario into the `test` dataset, sets `state.dataMode`, writes `audit_log`, and appends a fixed "Switched to test mode: <scenario>" or "Switched to live data" message with `persistMessages`. |
| `getUsageSummary(period?)` | Browser, `@callable`; also the tool of the same name | Reads `usage_charges` and `usage_source_status`, builds the summary with `domain/usage-summary.ts`. No model call. |
| `decideApproval(workflowId, approved, reason?)` | Browser, `@callable` | Checks the workflow is in `pendingApprovals`, writes `audit_log`, calls `approveWorkflow` or `rejectWorkflow`. |
| Workflow RPC targets | Workflow via `this.agent` | `writeSnapshot`, `saveCloseResult`, `finalizeClose`. Each is an upsert keyed on the period. |
| `onWorkflowProgress`, `onWorkflowComplete`, `onWorkflowError` | SDK | Keep `pendingApprovals` in state current. An error sets the close to `failed`. |

### InvoiceCloseWorkflow

`class InvoiceCloseWorkflow extends AgentWorkflow<InvoiceBuddyAgent, { periodStart: string }>`. The workflow is started with `id: "close-<periodStart>"`, so a second close of the same period cannot be created.

| Step | Kind | Does |
| --- | --- | --- |
| `snapshot` | `step.do` | Refuses an open period. `agent.writeSnapshot` copies the period's `usage_charges` into `usage_snapshots` if not already present. |
| `rate` | `step.do` | Totals the snapshot per service and reconciles with the invoice (`domain/reconcile.ts`). |
| `anomaly-check` | `step.do` | Runs the detectors on the snapshot. `agent.saveCloseResult`. |
| approval | `waitForApproval(step, { timeout: "7 days" })` | Rejection sets `rejected`; timeout sets `expired`. The period stays open. |
| `finalize` | `step.do` | `agent.finalizeClose`: sets `closed` and `closed_at`. Idempotent. |
| done | `step.reportComplete` | |

Local development limits from the docs: `pauseWorkflow`, `resumeWorkflow`, `terminateWorkflow` and `restartWorkflow` do not work under `wrangler dev`. The workflow does not use them.

## 9. Client

The starter's `app.tsx` is kept. Changes:

- Fetch `/api/session`, then `useAgent({ agent: "InvoiceBuddyAgent", name: accountId })`.
- **Mode switch and banner:** a switch in the header with a scenario picker calls the `setDataMode` callable. While `state.dataMode.dataset` is `test`, a persistent banner reads "Test mode: <scenario>. Figures are fixture data." and every card and the usage panel carry a test-data badge. A chat request to switch renders the SDK's tool approval prompt with Confirm and Cancel.
- **Usage summary panel:** always visible beside the chat, and above it on narrow screens. It is not a tool card and does not depend on the model. It calls the `getUsageSummary` callable on connect and whenever `state.lastSyncAt` changes. Each row shows product, metric, quantity and unit, an allowance bar when an allowance is known, and the billed amount. Unavailable rows and unavailable amounts are labelled as such with the reason. The footer shows the period and last sync time.
- **Breakdown card:** rendered from the `explainBillChange` tool part. Shows the per-product table, the daily series for top movers, findings with evidence, the unexplained remainder and data gaps. This card is the grounded source of truth on screen.
- **Credit draft card:** rendered from the `draftCreditRequest` tool part. Shows the draft with a copy button, the evidence, and the submission instructions with the support link.
- **Close approval card:** rendered from `state.pendingApprovals`. Shows the close summary and its findings. Approve and Reject call `agent.call("decideApproval", …)`. Reject asks for an optional reason.
- **Cost footer:** rendered from `state.selfCost`. Shows this month's metered cost and today's neurons against the budget, with a warning style from 80%. A tooltip carries the UC-8 limit statements.
- **Credit request list:** rendered from `state.creditRequests`, with owner-reported outcomes marked as such.
- Tool results render as text through React. No `dangerouslySetInnerHTML`. Docs links open in a new tab with `rel="noopener noreferrer"`.
- Cards meet WCAG 2.2 AA: buttons are labelled, tables have headers, state changes are announced.

## 10. Tests

### Tooling

`vitest.config.ts` uses the `cloudflareTest` plugin from `@cloudflare/vitest-plugin` pointed at `wrangler.jsonc`. Coverage uses the Istanbul provider; V8 coverage is not supported in the Workers pool. Thresholds are set in the config: 80% for lines, branches, functions and statements globally, 95% for `src/domain/**`.

Scripts: `test`, `test:watch`, `test:coverage`, `test:e2e`, `eval`, plus the starter's `check` (`oxfmt --check . && oxlint src/ && tsc`).

### Layers

| Layer | Runs in | Covers |
| --- | --- | --- |
| Unit | Vitest | Everything in `domain/`: money, periods, breakdown, each detector, reconciliation, the grounding checker, the draft template, the cost conversion and budget check. Table-driven, including empty, single-period, zero-cost and negative-delta inputs. |
| Integration | Vitest in the Workers runtime | Migrations; each tool against seeded SQLite; `syncUsage` with a failing source; auth hooks (no JWT, wrong audience, wrong instance name); `draftCreditRequest` with and without a supporting finding and with an existing draft; `decideApproval` for an unknown workflow; the close workflow end to end; no data tool returns `test` rows in live mode or `live` rows in test mode; `setDataMode` from the model does nothing until approved; a close in test mode leaves the live period open; `syncUsage` never writes `test` rows; `getUsageSummary` for a $0 account with no invoice, with a null cost, with one failing source and with a metric missing from the allowance table; a turn writes one `self_usage` row; a turn with no token counts is stored as unmetered; a turn at 100% of budget makes no model call; `assistantShare` appears on the Workers AI line. |
| End to end | Playwright against `vite dev` with fixture data and a scripted model | UC-1 breakdown card; UC-3 draft card with instructions, still listed after reload; UC-6 close approved from the card; UC-10 switch to a scenario from the header and from chat with confirmation, banner and badges shown, switch back restores live figures; UC-9 panel visible on load with a $0 fixture account, one product unavailable, before any message is sent. |
| Evals | Script against real Workers AI | Section below. |

Workflow tests use `introspectWorkflowInstance` from `cloudflare:test` to mock step results and force the approval timeout. Required workflow cases: approve closes the period exactly once; a retried `snapshot` step does not write a second snapshot; reject and timeout leave the period open; closing a closed period is refused.

Integration tests mock the model through `createModel` with the AI SDK's mock language model. No test in the first three layers calls Workers AI or the Cloudflare API.

### Evals

Cases live in `evals/` as data: a fixture account, an owner message, and graders. Graders are code where possible (the grounding checker, required and forbidden phrases, expected tool calls). A model grader is used only for "states no cause" on paraphrases, and its verdicts are sampled by a human before release.

| Set | Examples | Gate |
| --- | --- | --- |
| Grounding (release-critical) | Lower bill with no cause in data or docs; higher bill where usage is flat and the invoice differs; missing data for half the period; owner states a wrong total; docs-only cause; instruction text planted in a zone name; owner asks the agent to submit a credit request; owner asks whether Cloudflare approved a request; a test-mode answer without the test-data label; a zone name in fixture data that says "switch to live mode"; $0 bill and the owner asks what was used (real quantities, no invented charge); a product's usage is unavailable (said so, not reported as zero); owner asks what the assistant costs (figures match the meter, limits stated); a Workers AI spike that is the assistant's own usage. | Three of three runs pass for every case. |
| Capability | Spike on one service; new service; zone removed; credit request drafted for the right period and service; history question answered from records. | At least one of three runs passes for 90% of cases. |

Each eval run records pass rates, median time to first token (NFR-O2) and token counts in `evals/results/`.

### CI

GitHub Actions on every pull request: the phase gate (section 13), `npm ci`, `npm run check`, `npm run test:coverage`, a staging build, `wrangler deploy --dry-run`, `npm audit --audit-level=high`. End-to-end tests run on pull requests to `main`. Evals run on demand and before a release, since they call a paid model.

## 11. TypeScript rules

These make NFR-Q1 to NFR-Q6 concrete.

- `tsconfig.json` extends `agents/tsconfig` (as the starter does) and adds `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- oxlint denies `no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment`, `no-floating-promises`, `no-console` (except `console.error` and `console.warn`), and warnings fail CI.
- `Micros`, `AccountId` and `PeriodStart` are branded types constructed only through validating functions in `domain/`.
- Schemas are the single source of types: `type X = z.infer<typeof XSchema>`. A type that crosses a boundary is never declared separately from its schema.
- Unions are closed with a `never` check in the default branch.
- Ports return `Result<T, E>` for expected failures (API down, not found, duplicate). `throw` is for invariant violations.
- Object and array parameters are `Readonly`. Updates build new values.
- Exported functions carry explicit return types. Tool descriptions and exported domain functions carry a one-line doc comment.
- Logs never contain the API token, the Access JWT or message text. Errors shown to the owner are generic; detail goes to the log.

## 12. Self-cost meter and budget

Implements UC-8 and NFR-O3. The logic is in `domain/self-cost.ts`; the agent only stores and reads.

**Price constants.** One object: neurons per million input tokens (26,668) and output tokens (204,805) for the model, dollars per 1,000 neurons (0.011), the free daily allocation (10,000 neurons, account-wide, reset at 00:00 UTC), the included monthly amounts for Durable Objects and Workflows, the source URLs and the date checked (2026-10-04). A unit test fails when the date is more than 90 days old, which forces a re-check.

**Meter.** `streamText`'s `onFinish` callback supplies the turn's total token usage across steps. The agent converts it with `toNeurons` and `toCostMicros` and inserts one `self_usage` row. Workers AI also returns the neuron count for each call; when present it is stored as reported, and the converted figure is kept as a cross-check. If usage is absent, or reports zero input tokens (the provider's stand-in for missing usage), the row is written with `metered = 0`. Nothing is estimated from text length. The same callback increments `self_activity_daily` and updates `state.selfCost`.

**Budget.** At the start of `onChatMessage`, before any model call, `checkBudget(todayNeurons, DAILY_NEURON_BUDGET)` returns `ok`, `warn` (80% or more) or `exhausted`. On `exhausted` the agent returns a fixed message, increments `refused_turns` and does not call the model. A turn already running is allowed to finish, so the day's total can exceed the budget by one turn. The default budget equals the free daily allocation.

**Own share.** `explainBillChange` adds `assistantShare` to the Workers AI product row: the sum of `self_usage.cost_micros` for the period, the count of unmetered turns, and the note that the figure is at list price before the free allocation. When a `usage-spike` finding is on Workers AI, the finding's statement includes the assistant's share of the spike days. The service name that identifies Workers AI in usage records is a named constant (V10).

**Report.** `getAssistantCost` reads `self_usage` and `self_activity_daily`. Model figures are exact sums. Durable Object requests are estimated as incoming messages divided by 20, plus scheduled runs, plus workflow calls, following Cloudflare's stated billing ratio for WebSocket messages; the result carries `estimated: true` and is compared with the included monthly amount. Storage and duration are not estimated; the report says so.

## 13. Deployment

Implements NFR-D1 to D7.

### Environments

| Environment | Worker | Data | Deployed by |
| --- | --- | --- | --- |
| Local | `vite dev` | Live sources if `.dev.vars` has a token; test mode otherwise | Developer |
| Staging | `cf-invoice-buddy-staging` | Same account and sources as production, in its own Durable Object; feature checks run in test mode | CI, on every merge to `main` |
| Production | `cf-invoice-buddy` | The real account, from phase 3; test mode available on request | CI, by manual promotion of a commit that passed staging |

Both deployed environments are behind Cloudflare Access from their first deployment. Preview URLs are off. If the `workers.dev` hostname is enabled it is covered by the same Access policy; otherwise it is disabled.

### Pipeline (`deploy.yml`)

1. Build with `CLOUDFLARE_ENV=staging`, embedding the commit SHA.
2. `wrangler deploy` to staging through `cloudflare/wrangler-action`.
3. Run `scripts/smoke.ts` against staging.
4. On manual promotion: build for production, deploy, run the smoke test against production.
5. If the production smoke test fails, run `wrangler rollback` to the previous version and fail the job.
6. On success, append a row to `spec/deployments.md` and push the tag `deployed/phase-<n>`.

**Interim, decided 2026-10-05.** Until the deploy token is added to GitHub, the same steps run from the developer's machine as `npm run deploy:staging` and `npm run deploy:production`, authenticated by the Wrangler login. The script refuses to deploy a dirty working tree or a commit that is not on `origin/main`, and it is the script, not a person, that pushes the `deployed/phase-<n>` tag after the production smoke test passes. `deploy.yml` is written in phase 1 and switched on when the secret `CLOUDFLARE_API_TOKEN` exists; from then on local deploys are refused.

Deploy jobs run one at a time. The deploy token has only the "Edit Cloudflare Workers" permission on this one account and lives in GitHub secrets as `CLOUDFLARE_API_TOKEN`. It is a different token from the runtime billing-read token.

### Smoke test

`scripts/smoke.ts` takes a base URL and authenticates with an Access service token.

| Check | From phase |
| --- | --- |
| A request with no credentials is refused on every hostname of the Worker. | 1 |
| `/api/version` returns the expected commit SHA and reports configuration complete. | 1 |
| A connection to an agent instance other than the account's is refused. | 1 |
| One chat turn over WebSocket returns a non-empty streamed reply from the real model. | 1 |
| The turn produced a `self_usage` row. (The meter is built in phase 1.) | 1 |
| Workers Logs show no error-level entries for the smoke run. | 1 |
| The usage summary returns at least the assistant's own Workers AI usage, with no row reported as zero when its source failed. | 3 |
| Switching to a test scenario and back works, and the live usage summary is unchanged afterwards. | 3 |
| One check per later phase for what that phase built, run in test mode on a named scenario, in staging and in production. | 4 onward |

The smoke turn spends real neurons, a few hundred per run, and is counted by the meter like any other turn.

### Phase gate

The file `.phase` holds the number of the phase being worked on. The CI `gate` job fails a pull request when `.phase` is `n` and the tag `deployed/phase-<n-1>` does not exist. Only the deploy script creates that tag, and only after the production smoke test passes. A pull request that raises `.phase` therefore cannot merge until the previous phase is live.

### Hardening drills (phase 1)

Each is run once on staging, then recorded in `spec/deployments.md` with the commands used.

| Drill | Proves |
| --- | --- |
| Deploy a trivial change, then `wrangler rollback`. | Rollback works and the smoke test passes on the restored version. |
| Deploy a commit with a deliberately failing smoke check. | Production promotion is blocked. |
| Deploy app schema migration `0002` (additive) over existing data, then roll the code back. | Data survives and the previous code reads the newer schema (NFR-D6). |
| Deploy with one secret removed. | The deployment fails the smoke test with a log line naming the variable. |
| Run the full pipeline twice from a clean checkout. | The path is repeatable and needs no laptop state. |

Limits from the Cloudflare docs that shape this: a rollback cannot cross a Durable Object class change, and such a change deploys only with `wrangler deploy`, not as an uploaded version. Any change to the `migrations` array therefore ships in a commit of its own, and `v1` is deployed in phase 1 before there is data to lose. SQLite schema changes inside the agent are not undone by a rollback, which is why they must be additive.

## 14. Validation record

### Checked against the Cloudflare docs (2026-10-04)

| Topic | Source | Result |
| --- | --- | --- |
| Project shape, packages, `AIChatAgent`, `onChatMessage`, `streamText`, `routeAgentRequest` | Chat agent guide; `agents-starter` `server.ts`, `package.json`, `wrangler.jsonc` | Matches. |
| Model ID and function calling | Workers AI model page | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` exists, supports function calling, 24,000-token context. The guide itself uses a different Llama model; nothing in it depends on which. |
| `AgentWorkflow`, `runWorkflow`, `waitForApproval`, `approveWorkflow`, `rejectWorkflow`, `WorkflowRejectedError`, callbacks, `workflows` config | Run Workflows; Human-in-the-loop | Matches. |
| How to submit a billing support case | Contacting Cloudflare Support | Dashboard Support page, Billing, Create a Case. Open to Free plans for billing issues. |
| `persistMessages`, `onChatResponse` | Chat agents; Autonomous responses | Matches the use made of them in section 7. |
| Auth hooks `onBeforeConnect`, `onBeforeRequest`; `getAgentByName` | Routing | Matches. |
| MCP client `addMcpServer`, `waitForMcpConnections`; docs server URL | MCP client API; Cloudflare's MCP server catalog | Matches. |
| Vitest setup, Istanbul-only coverage, workflow introspection | Testing your Agents; Workers Vitest known issues and test APIs | Matches. |
| Platform pricing used by the meter | Workers AI, Durable Objects, Workflows and Workers pricing pages | Rates and included amounts as written in section 12. |
| Environments with the Vite plugin; Workers Logs; GitHub Actions deploy; rollback limits | Vite plugin Cloudflare environments; Workers Logs; GitHub Actions; Rollbacks; Durable Objects migrations | Matches section 13. The docs now recommend a declarative `exports` field over the `migrations` array for new Workers. This spec keeps `migrations` because the Agents guide and the starter use it; both remain supported. |
| Billing endpoints and usage record fields | Cloudflare OpenAPI spec | `billable-usage` (alpha), `billing/history`, `billing/credits` exist as described. No endpoint submits a credit request. |

### Access and API check (2026-10-04)

Run against the real account with the local `cf` login, the live Workers AI and docs MCP endpoints, and the installed starter packages (`agents` 0.17.4, `@cloudflare/ai-chat` 0.9.3, `ai` 6.0.233, `workers-ai-provider` 3.3.1). The stack was upgraded afterwards; see the re-check below.

**Blocked: needs action on the account before phase 1 can start**

| # | Finding | Blocks | Needed |
| --- | --- | --- | --- |
| B1 | Resolved 2026-10-05. An account API token with `Billing Read` and `Account Analytics Read` returns 200 from `billable-usage`, `billable-usage/info`, `billing/history`, `subscriptions` and `billing/credits`. On this account they are empty: `info` reports `covered: false` with no subscriptions, and there are no invoices. | Nothing | Nothing. The v1 record granularity and the Workers AI service name (V1, V10 for v1) stay unknown until the account has a usage-based subscription. |
| B2 | The account was created on 2026-10-05 UTC, has no subscriptions, and its billing profile returns 404. There are no invoices and no usage history to explain. `billable-usage` is alpha and pay-as-you-go only; whether it returns anything for this account is unknown. | Nothing | Decided 2026-10-05: v1 starts on this account. UC-9 works on it from real usage. UC-1, UC-2, UC-6 and UC-7 are proven in test mode (UC-10) until the account has charges, then re-checked on live data. |
| B7 | Resolved 2026-10-05 through GraphQL. With the token, the GraphQL Analytics API returned this account's real Workers AI usage for 2026-10-05: 3 requests, 343 input tokens, 31 output tokens and 15.50 neurons for Llama 3.3, which equals the published per-token rates. The account schema exposes `aiInferenceAdaptiveGroups`, `workersInvocationsAdaptive` (with a script name dimension), `durableObjectsInvocationsAdaptiveGroups`, `durableObjectsPeriodicGroups`, `durableObjectsSqlStorageGroups` and `workflowsAdaptiveGroups`, each with a `date` dimension. The v2 usage API still returns 403 `insufficient_permissions` with `Billing Read`. | Nothing | Nothing for UC-9. v2 access remains a Cloudflare-side grant and is no longer needed. |
| B3 | Resolved 2026-10-05. Zero Trust is set up; the Access organization exists and has an auth domain. No Access application or policy exists yet for the Worker. | Nothing | The application, policy and service token are created in phase 1. |
| B4 | Resolved 2026-10-05 for local work. Wrangler is logged in with Workers, Workers scripts and AI write scopes, which covers local development against the real model. Decided: deployments use the Wrangler login from the developer's machine for now, and move to an API token in CI once it is connected to GitHub (section 13). | Nothing now; CI deploys later | A deploy token from the "Edit Cloudflare Workers" template, limited to this account, stored as the GitHub secret `CLOUDFLARE_API_TOKEN`. It is separate from the runtime read token. |
| B5 | Resolved 2026-10-05. The GitHub CLI is logged in with `repo` and `workflow` scopes and can see the repository, which is public. | Nothing | Nothing. |
| B6 | Resolved 2026-10-05. The account is on Workers Free. Real chat turns completed in staging and production on every smoke run, so a phase-1 turn fits the free plan's limits. Turns with tool calls are heavier and are re-checked by the smoke test in later phases. | Nothing now | Workers Paid if a later phase's smoke turn fails on CPU time. |

**Defect found and worked around in phase 1**

| # | Finding | Blocks | Needed |
| --- | --- | --- | --- |
| B8 | With Llama 3.3, every streamed text chunk reached the client twice. The model's stream carries the text in two fields of each chunk (`response` and `choices[0].delta.content`), and `workers-ai-provider` emits both. Reproduced locally on provider 3.3.1 and on 4.0.0; the code path is unchanged between them. Worked around on 2026-10-05: `src/domain/dedupe-stream.ts` wraps the AI binding and removes `response` from a stream chunk only when both fields hold the same text. Verified against the real model: each chunk now arrives once. | Nothing | Remove the wrapper once the provider or the stream is fixed. The smoke test must assert that a reply contains no doubled words, so a regression in either direction is caught. |

**Re-checked on the upgraded stack (2026-10-05)**

`waitForApproval`, `persistMessages`, `onChatResponse`, `waitUntilStable`, `saveMessages`, `runWorkflow`, `approveWorkflow`, `rejectWorkflow`, `addMcpServer`, `waitForMcpConnections`, `routeAgentRequest`, `getAgentByName`, tool `needsApproval`, `pruneMessages`, `stepCountIs`, `totalUsage` and the provider's usage mapping are all present with the behaviour recorded below. The mock model is now `MockLanguageModelV4`. The build still emits the agent as a named class. Type check, lint, 13 unit tests and the production build pass. A live local turn reached the real model and the agent declined to state any figure, as its phase-1 prompt requires.

**Confirmed**

| # | Item | Result |
| --- | --- | --- |
| V2 | Billing permission name | `Billing Read`, account-scoped. |
| V3 | `waitForApproval` on timeout | It calls `step.waitForEvent` with the timeout, so a timeout surfaces as that call's error. Rejection throws `WorkflowRejectedError`. The workflow treats any other error from the wait as expiry; a test pins the error type. |
| V4 | `persistMessages` argument | It upserts the messages given and broadcasts that same list. Pass the full list, `[...this.messages, notice]`. |
| V5 | Docs MCP server | Reachable without credentials. Tool `search_cloudflare_documentation` returns similarity, id, url, title and text per result. |
| V6 | Mock model | `MockLanguageModelV3` from `ai/test`. |
| V7 | Class names in the build | The starter's Vite build emits `var ChatAgent = class extends AIChatAgent`, which keeps the name. |
| V9 | Token usage | A live call returned `prompt_tokens`, `completion_tokens` and `neurons`; the neuron figure matched the published per-token rates. The provider reads usage from stream chunks. It reports missing usage as zero tokens, so the meter treats zero input tokens as unmetered. Not yet seen end to end through the Worker binding (needs B4). |
| V11 | Fixed reply without a model call | `onChatMessage` may return a plain `Response`. |
| V12 | Access | Service tokens use `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Access can protect one Worker's `workers.dev` and preview URLs. `workers_dev` and `preview_urls` are valid config keys. Workers also expose the signed-in identity as `ctx.access`, which may replace hand-written JWT checks in section 3. |
| — | Model access and tool calling | Llama 3.3 ran on the account and returned a well-formed tool call for a test tool. |
| — | Workflows API | Reachable; no Workflows exist yet. |

**Still open**

| # | Item | Why it is open |
| --- | --- | --- |
| V1 | Whether usage records are daily | B1, B2. |
| V10 | The Workers AI service name in usage records | B1, B2. |
| V13 | An actual deployment of Worker, Durable Object and Workflow | The login has Workers write scopes, but nothing was deployed: it would create a public Worker before Access exists (B3). |
| V8 | oxlint rule names | The installed oxlint did not list them; confirm when writing the lint config. |

### Phase 1 implementation notes (2026-10-05)

Where the build differs from the sections above, this list is current and the sections are to be corrected when phase 1 closes.

| Topic | What was built | Why |
| --- | --- | --- |
| Access (section 3, 13) | A hostname-based self-hosted Access application per environment, on the Worker's `workers.dev` hostname. | Cloudflare's docs state that Worker-level Access policies do not support WebSocket connections and return 403 on upgrade. The chat runs over WebSocket. |
| Identifiers (section 1) | `CF_ACCOUNT_ID`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are secrets, like `CF_API_TOKEN`. They are not in `wrangler.jsonc`. | The repository is public. |
| Secrets (section 13) | Each environment's secrets live in `.secrets/<env>.env`, git-ignored, and are uploaded by `wrangler deploy --secrets-file`. Smoke test credentials are in `.secrets/smoke.env`. | One command sets code and secrets together, including on the first deploy. |
| Promotion (section 13) | A staging pass tags the commit `staging-ok/<sha>` locally. The production deploy refuses a commit without that tag. | Enforces staging before production while deploys run from one machine. |
| `/api/version` (section 3) | Behind authentication. A misconfigured Worker answers every request with a 500 listing the invalid variable names. | The names are needed to diagnose a bad deploy; values are never returned. |
| Instance lock (section 3) | Checked in the Worker's `fetch` handler before routing, not in the routing hooks. | Simpler, and covered by a test. |
| Smoke test (section 13) | Six checks: no-credential refusal, commit and configuration, session, foreign instance refusal, one real chat turn that must be undoubled and metered, and the Worker's live logs. The logs check follows `wrangler tail` during the run and fails on a failed invocation, an uncaught exception or an error-level log line. | `wrangler tail` works with the existing login. Log events contain request headers, so their content is never printed. |
| Meter (section 12) | `self_activity_daily` holds chat and refused turns only. Incoming message, scheduled run and workflow step counters are added with the features that produce them. | Nothing produces them in phase 1. |
| Tests (section 10) | Integration tests run with remote bindings off and fixed test values, so they need no Cloudflare login and no `.dev.vars`. | CI has neither. |
| Coverage (section 10) | Measured in two runs: domain code by the unit tests alone at 95%, the rest of the Worker by the integration tests at 80%. | Measuring domain files in both test projects at once made the merged figures depend on run order. CI on `main` failed on this for six commits while passing locally, and phase 1 was deployed during that time. |

**Deployed 2026-10-05.** Staging and production run behind Access and pass the smoke test. The five hardening drills are recorded in `spec/deployments.md`. They found two flaws in the smoke test, both fixed: it now waits for the intended commit to be served, and it retries a failed WebSocket connection. The Workers logs check and the automatic production rollback were added and exercised the same day; the rollback drill is in the record. One item carries over: the CI deploy workflow, which waits for a deploy token in GitHub. Until then deploys run from a developer machine.

**Token usage through the stream wrapper.** Verified three ways: unit tests show a usage-only chunk passes through byte for byte and that usage is untouched on a chunk whose duplicate text is removed; an integration test shows the agent meters 343 input and 31 output tokens as 15.496 neurons and 170 micro-dollars; and a live local turn through the real model and the wrapper was metered at 8.17 neurons with no unmetered turns.

### Phase 2 implementation notes (2026-10-05)

Phase 2 built the pure billing logic in `src/domain/`: `money.ts`, `periods.ts`, `usage.ts`, `breakdown.ts`, `findings.ts`, `detectors.ts` and `reconcile.ts`. Nothing in the Worker calls it yet; phase 3 and 4 do.

| Topic | What was built | Note |
| --- | --- | --- |
| Usage record | One record per day, service and metric, with optional zone, quantity and unit, an optional billable quantity, and a cost that may be null. | The billable quantity is what lets a detector see an included allowance run out. A null cost is counted as "uncosted", never as zero. |
| Baseline | The mean of the baseline periods per service, rounded once per service. The total baseline is the sum of those, so the per-service differences always add up to the total difference (UC-1). Fewer than two baseline periods gives no comparison. | The caller chooses the baseline periods; the default of the three preceding closed periods is applied in phase 4. |
| Detectors | All eight from section 6, in one file with the types in `findings.ts`, not one file per detector. | They share helpers and the file stays under the 400-line limit. |
| `usage-spike` | A day costing at least 3 times the service's median daily cost over the baseline periods. | Section 6 says a trailing 28-day median. The baseline periods are used so the detector needs no data outside what the comparison already loads. |
| `usage-drop` | A service costing half its usual or less. | Smaller decreases produce no finding and are reported as unexplained, which is what rule G-4 needs. |
| Minimum impact | A change under $1.00 produces no finding. | Named constants at the top of `detectors.ts`. |
| Unexplained remainder | The total difference minus what the service-level findings (spike, drop, new, removed) account for, each capped at its service's actual change. | Zone, allowance, period-length and invoice findings describe the same dollars from another angle, so they are not subtracted. |
| Reconciliation | An invoice within the larger of $1.00 or 1% of the summed usage is a match. | Used by the `invoice-variance` detector and, later, the invoice close. |
| Fixtures | `test/fixtures/usage.ts` builds daily records for a service and period. | The named scenario files for test mode come in phase 3 and will use the same builder. |

### Phase 3 implementation notes (2026-10-05)

Phase 3 built the usage data path, the usage summary (UC-9) and test mode (UC-10).

| Topic | What was built | Note |
| --- | --- | --- |
| Usage source | `GraphqlUsageSource` queries five datasets, one request each: Workers AI neurons, Workers requests, Durable Objects requests, Durable Objects duration and rows read and written, and Workflows steps. | Field names were confirmed against the account's schema and the adapter tests replay the real response shapes. A product with any failed dataset contributes no rows and is reported as unavailable. |
| Billing source | `CloudflareBillingSource` reads coverage and invoice history and answers one question: does the account have charges? No subscription and no invoices gives "no charges". Anything else gives "unavailable", because charge records are not read yet. | The charge record shape still cannot be observed on this account (V1, V10). A paid account will see quantities with amounts marked unavailable until that is built. |
| Storage | Migration 3: `usage_records`, `usage_source_status` and `account_billing`, each keyed by dataset. `invoices` and `usage_snapshots` are added with the phases that use them. | Table and column names differ slightly from section 4; the code is current. |
| Sync | On first use and every six hours by cron, for the current period only. | Earlier periods are fetched in phase 4, which needs them for baselines. |
| Billing period | Calendar month for an account with no billing cycle. | The anchor day comes from the billing API once an account has one. |
| Allowances | `src/domain/allowances.ts`: Workers Free and Workers Paid amounts for the metrics above, with sources and a check date that a test keeps under 90 days old. | Free-plan allowances are daily, so their share is measured against today's usage; paid ones against the period. |
| Test mode | Four scenarios in `src/domain/scenarios.ts`, built relative to today: usage spike, lower bill with no cause, new product, no charges. `setDataMode` is a callable for the UI switch and a tool with `needsApproval`. | A test proves a model-initiated switch does nothing without approval. Each switch is audited and announced in chat with fixed wording. |
| Tools | `getUsageSummary` and `setDataMode`. The summary given to the model has every figure as text and names its dataset. | First phase in which the model calls tools. |
| UI | Usage panel above the chat, collapsible; a data-mode select in the header; a test-mode banner. | Section 9 says beside the chat on wide screens. Above was simpler and works at every width. Not yet viewed in a browser by the developer. |
| Stream wrapper | Now also removes a numeric `response`. Workers AI sends a numeric token as a JSON number there and as text in the delta, so every digit group in a reply was doubled ("311" became "311311"). | Found by the first live usage answer. The phase 1 smoke test could not see it because its replies had no digits. |
| Smoke test | Uses a dedicated agent instance, `<account id>-smoke`, which the Worker allows alongside the account's own. New checks: the usage summary shows real usage, test mode leaves live data unchanged, and a usage answer quotes a summary figure exactly. | Earlier smoke runs wrote their test questions into the owner's production conversation. Those messages are still there. |
| Local development | Needs an Access sign-in or service token, because the model connection goes through the protected production hostname. | See the README. |
| Coverage | Browser components are excluded from the Worker coverage run. | They are to be covered by the end-to-end tests in phase 9. Until then the panel and switch have no automated test. |

### Phase 4 implementation notes (2026-10-05)

Phase 4 built bill explanations (UC-1, UC-2) and the rest of the assistant's cost reporting (UC-8).

| Topic | What was built | Note |
| --- | --- | --- |
| Baseline | Decided 2026-10-05: the scheduled sync stays on the current period. `explainBillChange` takes an optional `baselineMonth`; the agent fetches that month on demand, stores it and marks it fetched, so it is not fetched twice. With no month named, the baseline is up to three preceding months already stored. A single month counts as a baseline only when it was named. | A month in which any product failed to load is not marked fetched and is fetched again next time. |
| Open period | A period still in progress is compared with the same number of days of each baseline month, and the result says so. | Comparing a part-month with whole months would always look like a drop. |
| Explanation | `src/domain/explain.ts` returns one object used both by the model and by the breakdown card: total, baseline, per-product differences, daily costs of the three biggest movers, findings with evidence, the unexplained remainder and notes on data gaps. Every figure is text. | Limited to eight products and three daily series for the model's context. The model is given the movers' names; the daily series is for the card. |
| Outcomes | `explained`, `none_found`, `no_baseline`, `no_charges`. Each carries a fixed instruction to the model, including the exact "I can't explain this difference from the account's data." wording. | |
| Own share | On live data the explanation includes one sentence on the assistant's own metered model usage in the period. It is left out in test mode, so real and fixture figures are never mixed (G-9). | It is a statement beside the breakdown, not a split of the Workers AI row, because the account has no Workers AI cost to split. |
| Cost report | `getAssistantCost`: month to date and the last seven days, with the three limit statements and the price source. The UI footer shows the month's metered cost and today's neurons against the budget. | Durable Object and Workflow activity is not estimated; the report says only model calls are metered. |
| Tools not built | `getInvoiceSummary` and `getUsageBreakdown` from section 5. | Invoices are not read on live data yet, and the explanation already carries the per-product and per-day figures. Add them when a use for them appears. |
| Tool input | The explain tool's schema is loose and non-month values are dropped with a note. | With a strict schema, a bad value made the model retry until the turn ended with no reply. |
| Stream wrapper, third fix | Streamed tool calls arrive both in the choices delta and in a top-level `tool_calls` field. The provider joined both and the arguments became invalid JSON, so every tool call with arguments failed. The wrapper now removes the top-level copy. | Phase 3 did not hit this because its tools took no arguments. |
| Prompt | Now built per turn with today's date and the current month. | Without a date the model invented months from 2023. |
| Model behaviour seen live | In test mode, three of three answers to the spike question and three of three to the lower-bill question were correct and labelled as test data. Two weaknesses: the model passes a baseline month the owner did not name (the previous month), and it does not point out when the owner's quoted figures differ from the data. One earlier reply contained figures that were in no tool result. | The response checker and the evaluation suite that would catch these are phase 5. Until then the breakdown card is the reliable source on screen. |
| Budget | The daily budget stopped a local test instance after failed tool-call loops used its 10,000 neurons. | The guard works; the loops are fixed by the two changes above. |
| File size | Tool definitions, the explain orchestration, scenario loading and the cost report moved out of `agent.ts` into `src/tools/`, `src/services/` and `src/db/`. | Keeps every file under 400 lines. |

**Phase 4 deployment status (2026-10-05).** Phase 4 is on staging. Production is on phase 3 after an automatic rollback. The production deploy is to be retried after the neuron allowance resets at 00:00 UTC.

### Failure investigation and free-tier guards (2026-10-05)

**What went wrong**

| Event | Cause, as far as established | Fix |
| --- | --- | --- |
| The account used 12,939 neurons in a day against the free 10,000. | Local test runs while streamed tool calls were broken: every call failed, and the model retried to the eight-step limit, eight model calls a turn with a growing context. Each agent instance also had its own budget of up to 10,000, so the budgets did not add up to the account's allowance. | Loop guard, lower step limit and budgets that fit the allowance, below. |
| Production deploy of phase 4 failed one smoke check and was rolled back. | The check required the reply to restate the bill total. The stored reply was correct and fully grounded but gave the difference and the cause, not the total. The check was too strict. | The check now requires that every dollar amount in the reply is one the tool returned, and requires none in particular. |
| On staging, a `setDataMode` call timed out after 30 seconds. | Not established. It could not be reproduced: six mode switches in a row took 41 to 78 ms with 2 to 13 ms of CPU. It happened straight after a model turn, at 04:55 UTC, when the account was near or past its daily allowance, so a model stream that never finished is the leading suspicion. It did not coincide with the six-hourly sync. | A stalled-stream timeout, below, so a hung model call cannot hold the agent. Open until seen again. |
| The smoke instance's conversation had grown to 42 messages. | Every run added its questions and answers, so each run sent the model a longer context and cost more. | The smoke test clears that instance's history at the start of each run. |

**Guards now in place (NFR-O4 to O6)**

| Guard | Where | Behaviour |
| --- | --- | --- |
| Loop detection | `src/domain/loop-guard.ts`, used as a `stopWhen` condition | Stops a turn after two consecutive steps with a failed tool call, or when the same tool call with the same input is made a third time. A test replays the 2026-10-05 failure and sees two model calls, not eight. |
| Step limit | `src/agent.ts` | Five model steps a turn, down from eight. |
| Stalled stream | `chatStreamStallTimeoutMs` | A model stream silent for 45 seconds is aborted. |
| Empty reply | `onChatResponse` | A turn that ends with no text and no approval prompt gets the fixed line "I couldn't complete that answer. Please try asking again, or rephrase the question." |
| Budgets | `wrangler.jsonc` | Per instance, per day: production owner 5,000 and smoke 600; staging owner 400 and smoke 1,000; local owner 1,000 and smoke 1,000. Total 9,000. `test/unit/free-tier.test.ts` fails if the total passes 9,000. |
| Smoke pre-flight | `scripts/smoke.mjs`, run by `scripts/deploy.mjs` before uploading | Reads the account's neurons for the day from GraphQL Analytics and refuses to run past 8,000. Refuses if the figure cannot be read. Also checks the smoke instance's own budget before the first model call. |
| One model turn | `scripts/smoke.mjs` | Decided 2026-10-05. The run makes a single model call sequence: the bill explanation in test mode. That one turn is checked for grounding, the test-data label, doubled words and metering. The separate usage-answer turn was removed; usage figures are checked without the model. Eight checks in all, seven with no model call. |

These budgets guarantee the allowance only for what the app itself spends. Model calls made outside it, such as from the `cf` command line, are not counted by any budget, which is why 1,000 neurons are left unallocated and the pre-flight check reads the account-wide figure.

**Duplicate files.** On 2026-10-05 the working tree, `.git` and `node_modules` filled with copies named like `explain 2.ts`: nine in the source tree, hundreds in `dist`, 7,854 in `node_modules`, and stray `index 2` and `refs/heads/main 2` files inside `.git` that made `git rev-list --all` fail. Six were committed by `git add -A` and broke CI. The cause is iCloud Drive: the Mac has "Desktop & Documents Folders" turned on, the repository is under `~/Documents`, the folder carries the iCloud file-provider markers and no other sync tool is running. iCloud writes a numbered copy when it sees a conflicting change, which a reinstall or a build produces by the thousand. All copies were deleted and `.gitignore` now ignores names ending in a space and a number, which also covers copies of ignored secret files such as `.dev 2.vars`. The whole `Code` folder was moved from `~/Documents/Code` to `~/Code` the same day, outside iCloud's reach. A direct rename was refused by the file provider, so it was copied, verified identical and then removed from the old location.

### Checked against ECC skills

| Skill | Applied as |
| --- | --- |
| `coding-standards` | Naming, immutability, schema validation at boundaries, no `any`, function and file size limits, named constants, explain-why comments: section 11 and NFR-Q1 to Q6. |
| `tdd-workflow` | Tests first, 80% on all four coverage measures, unit / integration / end-to-end layers, independent tests, under 30 seconds for unit tests, no skipped tests, one checkpoint commit each for red and green: NFR-T1 to T6 and section 15. |
| `eval-harness` | Evals defined before code, code graders preferred, three-of-three for release-critical cases and 90% at three attempts for capability, latency and cost tracked: section 10. |
| `security-review` | Secrets in the platform store, schema validation, parameterized SQL, authorization before sensitive actions, no unauthenticated routes, no sensitive data in logs or errors, dependency audit, lock file committed: section 3, NFR-S1 to S5. |

Deviations from the skills, on purpose: the eval definitions live in `evals/` in the repo rather than `.claude/evals/`, so they are versioned with the code; rate limiting is left to Cloudflare Access and Workers AI limits because there is one user per deployment.

## 15. Build order

Each phase is test-first. A phase is finished only when `check` and `test:coverage` pass, it is deployed to staging and production, the smoke test passes on both, and the deployment is recorded (NFR-D1). The gate in section 13 blocks the next phase until then.

1. **Scaffold and deployment cycle.** Starter in place, renamed agent, Llama 3.3, Vitest and CI. Access, `/api/version`, configuration check. The meter and budget from section 12, so cost is watched from the first deployed turn. Staging and production environments, the deploy pipeline, the smoke test, the phase gate and all five hardening drills. Settle V2, V6, V7, V8, V9, V11, V12, V13.
2. **Domain.** Money, periods, breakdown, detectors, reconciliation, with fixtures. No Cloudflare code. The deployed change is small; the phase still deploys.
3. **Data and usage summary.** Migrations, queries, `UsageSource` port with the adapters in section 4, `syncUsage`, the allowance table, `getUsageSummary` and the usage summary panel. The `dataset` column, scenarios, `setDataMode`, the mode switch and banner. Production gets its read tokens and shows this account's real usage. UC-9, UC-10.
4. **Explain.** `getInvoiceSummary`, `explainBillChange` with `assistantShare`, `getUsageBreakdown`, `getAssistantCost`, system prompt, breakdown card, cost footer. UC-1, UC-2 without docs, UC-8.
5. **Grounding.** Docs search, grounding checker, first eval run. Settle V5.
6. **Credit requests.** Draft template, `draftCreditRequest`, draft card, history, owner-reported outcomes. UC-3, UC-4. Settle V4.
7. **Invoice close.** Workflow and approval card. UC-6. Settle V3.
8. **Plans.** Price table and `comparePlans`. UC-7.
9. **Release.** End-to-end tests on staging, full eval run, accessibility pass, price constants re-checked.

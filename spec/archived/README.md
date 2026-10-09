# Archived specs

Copies of the spec at the points where its scope changed significantly, so the original and the final scope can be compared without going through the commit history. The current spec is in the parent folder. Nothing here is updated after it is archived.

| Folder | What it holds |
| --- | --- |
| [2026-10-04-original](2026-10-04-original/) | The spec as first committed, before any code (commit `075a20b`). |
| [2026-10-07-before-merge](2026-10-07-before-merge/) | The spec after phase 7, when the design sections still described the original design and every difference was a dated note in section 14 of the low-level spec. |
| [2026-10-09-before-dropping-invoice-close](2026-10-09-before-dropping-invoice-close/) | The spec with the monthly invoice close (UC-6) in it, as built: the workflow, its tools, the approval card and its tests. Archived when the owner dropped the use case. |

On 2026-10-07 the body of the current spec was rewritten to describe what was built. The dated notes remain in its section 14 as a record.

## What changed between the original and what was built

Each row says what the original spec planned and what the product does now. The reason, and the date, is in section 14 of the current low-level spec.

### Scope added after the original

| Addition | Why |
| --- | --- |
| Replies are held until checked, and withheld if they fail | The first evaluation run showed the model stating a figure and a link no tool had returned. The original checked a reply after it was shown and added a correction notice. |
| Free-tier guards: budgets that add up to under the account's allowance, counted over the trailing 24 hours; a loop guard; a five-step limit; a pre-flight check before the smoke test and before a deploy | The account's free model allowance was exhausted twice during the build. The original had one daily budget equal to the whole allowance, and an eight-step limit. |
| Stream repair for Llama 3.3 | Its stream carries each piece of output twice. Not foreseen. |
| A separate smoke-test instance of the agent | Smoke runs were writing into the owner's conversation. |
| AI Gateway cache for the smoke test, and cache hits left out of the meter | To make deploys cheaper to verify. |
| Recording and replaying the model's stream in tests | To test real model output without model calls. Built; no real recording made yet. |
| An optional cheaper model for the smoke test | Built, off, untried. |
| Running only the evaluation cases a change affects | Evaluation runs are the largest use of the allowance. |
| The Wrangler configuration kept out of git, with a template | Owner's decision. |
| A project skill recording what was observed about Cloudflare's platform | Owner's decision. |
| Response checker rules against claiming to have submitted a request or approved a close | To back the "agent never submits, never approves" rules with more than a prompt. |
| The owner's confirmation before a credit outcome is recorded | So the model cannot invent an outcome. |

### Built differently

| Original | Built | Why |
| --- | --- | --- |
| Usage and cost from the billable usage API, with other sources merged per product by a `USAGE_SOURCE` list | Quantities from the GraphQL Analytics API; the billing API tells only whether the account has charges, its plan and its invoices | The billing API is empty on a $0 account, and the shape of its charge records could not be observed. |
| Scenario fixture files, bundled with the Worker, with dates shifted | Five scenarios generated in code relative to today | Simpler, and always current. |
| Documentation search through the SDK's MCP client | One direct request to the documentation server | No connection to keep alive across the agent's sleep and wake. |
| One detector per file | All eight in one file | Small enough together. |
| The assistant's share shown on the Workers AI line, and named in a spike finding | One sentence with the assistant's own metered usage for the period | The name Workers AI has in billing records could not be observed. |
| The cost report estimates Durable Object and Workflow activity | Only model calls are metered, and the report says so | The counters behind the estimate were not built. |
| Budget counted per calendar day, refusing until 00:00 UTC | Counted over the trailing 24 hours | Cloudflare refused calls over the previous day's usage. |
| A usage panel beside the chat on wide screens | Above the chat at every width | Simpler. |
| A credit request list in the UI, fed from agent state | History shown as a card when asked | Not needed for the use case. |
| Credit amounts stored as micro-dollars | Stored as the text shown | Nothing computes with them. |
| Close workflow id `close-<period>`; three agent methods called by the workflow; a `usage_snapshots` table | A random part in the id; one method with the step as an argument; the snapshot stored on the close's row | A fixed id collides between agent instances and allows one attempt ever. |
| Close states `snapshotting`, `rating`, `checking` before the approval wait | One in-progress state, `snapshotted` | The steps take moments; the distinction told the owner nothing. |
| Access policies checked in the SDK's routing hooks; Worker-level Access | A hostname-based Access application, and an instance check in the Worker's `fetch` handler | Worker-level Access policies refuse WebSocket upgrades. |
| Secrets set one by one with `wrangler secret put`; the account ID in the configuration | One secrets file per environment, uploaded with the deploy; the account ID and Access values treated as secrets | One command for code and secrets; the repository is public. |
| A CI pipeline deploys on merge and promotes by hand | A script run from a developer machine, with the same steps | The deploy token has not been added to GitHub. |
| Coverage thresholds in one run | Two runs: domain code at 95% by the unit tests, the rest at 80% by the integration tests | A merged run gave figures that depended on run order. |
| A model grader for paraphrased "no cause" answers | Graders are code only | Not needed so far. |

### Built, then dropped

| Item | Why |
| --- | --- |
| Monthly invoice close (UC-6): a Cloudflare Workflow that froze a month's usage, totalled and checked it, and waited for the owner's approval | Dropped by the owner on 2026-10-09. Cloudflare has no operation that closes or approves an invoice, and the agent's access is read-only, so it was only a record in the agent's own database with a name that suggested otherwise. The original brief asked for it; nobody checked, before building it, what on Cloudflare's side it corresponded to. Every use case is now listed against the API access it needs, in section 7 of the high-level spec. |

### Planned and not built

| Item | State |
| --- | --- |
| Plan comparison (UC-7) and `comparePlans` | Phase 8. |
| End-to-end browser tests | Phase 9. |
| `getInvoiceSummary`, `getUsageBreakdown` | Dropped. The bill explanation and the usage summary cover what they were for, except a breakdown by day or zone on request, which is in the backlog. |
| `getInvoiceCloseStatus` | Replaced by `getInvoiceCloses`. |
| Per-record charges for a paid account | Backlog. |
| Stricter lint rules and `exactOptionalPropertyTypes` | Not configured. Listed in the high-level spec under where the build falls short. |
| A deploy workflow in CI | Waiting for the deploy token. |

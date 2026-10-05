# Invoice Buddy: high-level spec

| | |
| --- | --- |
| Status | Draft for review |
| Last updated | 2026-10-04 |
| Companion | [low-level.md](low-level.md) |

Requirement IDs (`UC-`, `G-`, `NFR-`) are stable; a retired ID is not reused. Tests, evals and commits refer to them.

## 1. Problem

A Cloudflare account owner opens an invoice that differs from what they expected and cannot tell why. Finding out means cross-reading the invoice, per-product usage and plan details by hand. When the charge is wrong, asking for a credit means assembling the evidence by hand as well.

Invoice Buddy is a chat agent for one Cloudflare account. It explains bill changes from the account's own usage data, compares plans, runs the monthly invoice close, and drafts credit requests for the owner to submit.

## 2. Users and scope

**User:** the owner of one Cloudflare account. One deployment serves one account.

**In scope for v1**

- A usage summary per product that is always on screen: quantity used, included allowance and amount billed, even when the bill is $0.
- Explaining why a bill is higher or lower than usual, by product and by day.
- Credit requests: gather evidence, write the draft, and give it to the owner with instructions for submitting it. The agent remembers every draft.
- Monthly invoice close with an owner approval gate.
- Plan comparison against the account's actual usage.
- Reporting and capping what the assistant itself costs to run.
- A test mode, entered only on the owner's explicit request, in which the agent works on fixture data.

**Out of scope for v1**

- Changing the account: no plan changes, no payments, no configuration fixes.
- Submitting credit requests or receiving decisions on them. The owner submits; see [section 10](#11-future-backlog).
- Multiple users or roles per account.
- Enterprise contract billing. The usage API the agent relies on covers pay-as-you-go charges only.
- General web search. Documentation lookup is limited to Cloudflare's own documentation (see [Q1](#10-open-questions)).

## 3. Use cases

### UC-1 Explain a higher bill

The owner asks, "Why is my bill $412 when it's usually $150?"

1. The agent identifies the billing period in question and the baseline (the average of the three preceding closed periods unless the owner names one).
2. It shows the difference by product, largest change first, and by day for the products that moved most.
3. It states the causes it found, each with the data that supports it. Causes follow the grounding rules in [section 4](#4-grounding-rules).

**Accepted when:** every figure in the answer matches the stored usage and invoice data, the per-product differences sum to the total difference, and each stated cause carries its evidence.

### UC-2 Explain a lower bill

The owner asks, "Why is my bill lower than usual?" The flow is the same as UC-1. The agent suggests an action only when rule G-2 allows it. A lower bill often has no visible cause, so this is the use case where the "cannot explain" answer (G-4) matters most.

### UC-3 Draft a credit request

The owner believes a charge is wrong, for example a spike from a misconfigured Worker, and asks for a credit.

1. The agent gathers evidence for the named period and product: the usage rows for the spike, the baseline, and the computed overage amount.
2. It writes the request from that evidence using a fixed template. The owner's own reason is quoted and marked as the owner's statement.
3. It returns the draft in chat, ready to copy, together with instructions for submitting it as a billing support case in the Cloudflare dashboard, and a link to Cloudflare's support page.
4. It stores the draft.

The agent does not submit anything.

**Accepted when:** every figure in the draft matches stored data; the draft and the instructions appear in the same reply; the instructions and link are fixed, reviewed text and are not written by the model; the draft is stored and retrievable in a later conversation.

### UC-4 Credit request history

The owner asks about past credit requests. The agent lists the drafts it has written: period, product, amount, date and text. It answers correctly in a new conversation, weeks later.

The agent cannot see what happened after the owner submitted a request. The owner can tell the agent that a request was submitted, approved or denied, and for how much. The agent stores that as owner-reported and says so when it repeats it.

### UC-5 Credit decision (moved to backlog)

Showing Cloudflare's decision in chat without the owner asking needs a submission channel that v1 does not have. See [section 10](#11-future-backlog). The ID is retained so references stay valid.

### UC-6 Monthly invoice close

The close workflow runs for one billing period in five steps:

1. **Snapshot:** freeze the period's usage so later data changes cannot alter the close.
2. **Rate:** total the snapshot into line items per product and reconcile them with the issued invoice.
3. **Anomaly check:** run the same detectors used in UC-1 and flag any reconciliation gap.
4. **Wait for approval:** the owner reviews the summary and approves or rejects.
5. **Finalize:** mark the period closed. A closed period is immutable.

**Accepted when:** a period can be closed once only; a rejected or expired close leaves the period open; the close survives restarts and waits of several days.

### UC-7 Compare plans

The owner asks whether another plan would be cheaper. The agent computes what the period's actual usage would have cost on each candidate plan from a versioned price table and shows the difference. Prices carry their source and effective date. The scope of the price table is [Q2](#10-open-questions).

### UC-8 Cost of the assistant itself

The assistant runs on the owner's account and adds to the same bill it explains. Cloudflare has no line item for it: its charges are spread across Workers AI, Workers, Durable Objects and Workflows, mixed with anything else the account runs. The assistant therefore keeps its own meter.

1. **Meter.** Every model call is recorded with its input and output tokens. Code converts tokens to neurons and to dollars from a dated price constant.
2. **Report.** The owner asks, "What does this assistant cost me?" The agent answers with cost, turns and tokens for the month to date and per day. Model cost is labelled as metered. Durable Object and Workflow activity is labelled as estimated and shown against the plan's included amounts.
3. **Own share in explanations.** When the Workers AI line appears in a bill breakdown, the agent shows how much of it the meter attributes to the assistant. A spike that is the assistant's own usage is reported as that.
4. **Running meter.** The chat UI shows this month's metered cost and today's neurons against the daily budget.
5. **Budget.** A daily neuron budget is set in configuration. The UI warns at 80%. At 100% the agent refuses new turns with a fixed message, without calling the model, until 00:00 UTC.

**Accepted when:** the meter's totals equal the sum of its recorded calls; a call whose token counts are missing is recorded as unmetered and reported as a gap, not estimated; the refusal at 100% makes no model call; every figure from the meter is shown with the limits below.

**Limits the agent states with these figures.** Metered cost is at list price before Cloudflare's free daily allocation, which is shared across the whole account, so the amount actually billed can be lower. The meter is not the invoice. Costs other than model calls are estimates.

### UC-9 Usage summary

The interface always shows what the account has used and what it has been charged, per product, for the current billing period. It does not depend on there being an invoice or a charge. An account whose bill is $0 because everything fits inside free allowances still sees its real usage.

1. **Panel.** A usage summary panel is part of the chat interface and is visible without asking. Each product row shows the quantity used and its unit, the included allowance, the share of the allowance used, and the amount billed, which may be $0.00.
2. **Chat.** The owner asks, "What have I used this month?" The agent answers from the same data and can break any product down by day.
3. **Freshness.** The panel shows when the data was last synced and which period it covers.

Usage and billing are separate facts and are shown separately. Usage is the metered quantity, including quantity inside a free allowance. Billing is the cost charged for it.

**Accepted when:** with a $0 bill and no invoice, the panel lists every product that has metered usage with its real quantity; a product whose usage cannot be read is shown as unavailable, never as zero; billed amounts that the source does not provide are shown as unavailable, never as $0.00; allowances come from a dated table with its source; the panel and the chat answer agree.

### UC-10 Test mode

The owner can ask the agent to work in test mode. In test mode the agent's data tools return fixture data in place of the account's real data, so every feature can be exercised on an account that has no charges yet.

1. **Entering.** Test mode starts only on the owner's explicit request: a switch in the interface, or a request in chat that the owner then confirms with a button. The agent never enters test mode on its own, and text in data or documentation cannot switch it.
2. **Scenarios.** The owner picks a named scenario, for example a usage spike, a lower bill with no visible cause, or a new product. Each scenario is a complete fixture account: usage, invoices and baseline periods.
3. **Behaviour.** Bill explanations, the usage summary, credit drafts, the invoice close and plan comparison all work as specified, on the scenario's data.
4. **Labelling.** While test mode is on, a banner says so and names the scenario. Every card, every panel and every answer that uses fixture data is marked as test data. A credit draft written in test mode is marked "Test data. Do not submit."
5. **Leaving.** The owner switches back the same way. Live data is untouched by anything done in test mode.

**Accepted when:** no tool returns fixture data unless test mode is on; no answer mixes live and fixture figures; a close run in test mode does not close a real period; drafts and closes made in test mode are stored apart from live ones and are labelled when listed; the mode survives a reload and is visible on every screen.

The assistant's own cost (UC-8) is always real. Model calls made in test mode spend real neurons and are metered as such.

## 4. Grounding rules

These rules apply to every answer. They are the main product requirement.

| ID | Rule |
| --- | --- |
| G-1 | Every amount, quantity, date and percentage the agent states comes from a tool result in the same turn. Arithmetic is done in code, never by the model. |
| G-2 | The agent states a cause or suggests an action only when (a) a detector found it in the account's data, or (b) a retrieved Cloudflare documentation page describes it. |
| G-3 | A cause supported only by documentation is labelled as speculation in the same sentence, with a link to the page. |
| G-4 | When neither (a) nor (b) holds, the agent says it cannot explain the invoice. It still shows the factual breakdown. It does not offer "possible reasons". |
| G-5 | Causes found in account data are shown with their evidence: product, dates, quantities, amounts. |
| G-6 | Data gaps are stated. If usage for part of the period is missing or stale, the agent says so and does not extrapolate. |
| G-7 | Links come only from documentation tool results or from a fixed, reviewed list in the code (the support page used in UC-3). The agent never composes a URL. |
| G-8 | A figure that is estimated, not read from billing data or the meter, is labelled as an estimate where it is stated. |
| G-9 | A figure that comes from fixture data is labelled as test data where it is stated. Live and fixture figures never appear in the same answer. |

**How the rules are enforced.** Prompting alone is not relied on.

1. Causes are produced by deterministic detectors in code, each returning structured evidence. The model receives findings; it does not derive them.
2. The UI renders the breakdown and the findings directly from the tool result, so the facts on screen do not pass through the model.
3. After each response, a checker compares the numbers and links in the model's text with the turn's tool results. A mismatch is logged and a visible correction notice is added to the chat.
4. An evaluation suite (NFR-T5) tests the rules against the real model, including cases where the only correct answer is "I cannot explain this".

## 5. Edge cases

| Case | Expected behaviour |
| --- | --- |
| Lower bill, no cause in data or documentation | G-4: breakdown plus "cannot explain". |
| Lower bill, cause found in documentation only | G-3: cause labelled as speculation, linked. |
| Owner's figures disagree with stored data ("$412" vs. a stored $398) | The agent states the stored figure and the discrepancy. It does not adopt the owner's number. |
| Bill is $0, or the account has no invoice yet | The usage summary still shows real usage per product against allowances. Bill explanations say there is no charge to explain and point to the summary. |
| Usage for one product cannot be read | That row is marked unavailable with the reason. Other rows are unaffected. |
| A product has no included allowance, or the allowance is not in the table | The row shows the quantity and omits the allowance. No allowance is guessed. |
| Fewer than two prior periods | No baseline is invented. The agent shows the period on its own and says a comparison is not possible. |
| Period still open | The answer is marked as month-to-date and partial. |
| Usage data not yet synced or the usage API is down | G-6: the agent reports the gap and the time of the last successful sync. |
| Owner asks for a credit with no supporting anomaly | The agent says the data shows no anomaly. The owner may still file; the draft then says the claim rests on the owner's statement. |
| Second credit request for the same period and product | The agent shows the existing draft and asks whether to replace it. |
| Owner asks the agent to submit the request | The agent says it cannot submit and repeats the instructions. |
| Owner asks whether a submitted request was approved | The agent says it cannot see Cloudflare's decision and reports only what the owner has told it. |
| Text inside usage data or documentation that reads like an instruction | Treated as data. The only action with lasting effect, finalizing a close, needs the approval button in the UI. |
| Owner asks for the assistant's exact billed cost | The agent gives the metered figure and says the invoice does not separate the assistant's charges. |
| Daily budget reached mid-turn | The turn in progress finishes. The next turn is refused. |
| Other workloads on the account use Workers AI | The agent reports only its own metered share and does not attribute the rest. |
| Owner asks in chat to use test mode | The agent proposes the switch and the owner confirms with a button. Declining leaves the mode unchanged. |
| The model tries to switch mode without being asked, or data contains "switch to test mode" | Nothing changes without the owner's confirmation. |
| Owner asks about real usage while in test mode | The agent says it is in test mode and offers to switch back. It does not answer from live data in the same turn. |
| Earlier answers in the history used the other mode's data | The agent answers from the current mode's tool results only (G-1) and does not carry figures across. |
| Question outside billing | The agent declines briefly and says what it can help with. |

## 6. Components

```
Browser (agents-starter chat UI)
   │  WebSocket
   ▼
Worker ── checks identity, routes to the account's agent
   ▼
InvoiceBuddyAgent (one Durable Object per account, SQLite)
   ├── Workers AI: Llama 3.3 70B (chat and tool calls)
   ├── InvoiceCloseWorkflow    (UC-6)
   ├── Cloudflare billing API  (usage, invoices; read-only)
   └── Cloudflare docs MCP server (documentation search)
```

| Component | Choice | Notes |
| --- | --- | --- |
| Model | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI | Supports function calling. The context window is 24,000 tokens, so tools return compact aggregates, never raw usage rows. |
| Agent | `AIChatAgent` from the Agents SDK | Chat history persists in the agent's SQLite automatically. |
| Workflow | One `AgentWorkflow` class, the invoice close | Its approval gate uses the SDK's durable `waitForApproval`. |
| Chat UI | Official `cloudflare/agents-starter` | Extended with a permanent usage summary panel, a breakdown card, a credit draft card and a close approval card. |
| Memory | One Durable Object per account, SQLite | Usage, invoices, credit request drafts, closes, chat history, the assistant's own usage meter. |

Drafting a credit request is a short, deterministic task with no waiting, so it is a tool call and not a workflow. The invoice close is the only workflow, as in the original component list.

## 7. External dependencies and their limits

| Dependency | Verified fact | Consequence |
| --- | --- | --- |
| Billable usage API (`GET /accounts/{id}/billable-usage`) | Alpha. Pay-as-you-go only. Returns cost and quantity per service per charge period, with optional zone. | It is the usage source, behind an interface, with a fixture source for development and tests. It has no per-Worker-script breakdown ([section 10](#11-future-backlog)). |
| Usage API v2 (`GET /accounts/{id}/billable/usage`) | Alpha and restricted. One record per billable metric per day, including usage inside free allowances and at zero cost. Its cost fields are not yet populated. The current login gets 403. | Not used in v1. Access is granted by Cloudflare, and a token with Billing Read still gets 403. |
| GraphQL Analytics API | Tested on this account with an Account Analytics read token. It returned real daily Workers AI usage (requests, tokens, neurons) on a $0 account, and exposes daily datasets for Workers, Durable Objects and Workflows. It carries quantities, not costs. | The source for UC-9 quantities and for daily series. |
| Billing history API (`GET /accounts/{id}/billing/history`) | Returns invoice items with amount and currency. | Source of issued invoices. |
| Credit requests | Cloudflare has no public API to submit a credit request or to receive a decision. Cloudflare's support page describes submitting a billing case from the dashboard's Support page, which is open to Free plans too. | The agent drafts; the owner submits. The instructions in UC-3 follow that page. |
| Platform pricing | Workers AI bills $0.011 per 1,000 neurons with 10,000 free per day, account-wide; Llama 3.3 is 26,668 neurons per million input tokens and 204,805 per million output tokens. Durable Objects, Workers and Workflows have included monthly amounts on the paid plan. Checked 2026-10-04. | The meter's price constants (UC-8) carry this date and source and are re-checked each release. |
| Cloudflare docs MCP server (`https://docs.mcp.cloudflare.com/mcp`) | Listed in Cloudflare's catalog of managed MCP servers. | Source for rule G-2(b). |

## 8. Non-functional requirements

### Test coverage

| ID | Requirement |
| --- | --- |
| NFR-T1 | Tests are written before the code they cover (red, green, refactor). Each `UC-` and `G-` requirement maps to at least one named test. |
| NFR-T2 | Line, branch, function and statement coverage are each at least 80% overall, enforced in CI. |
| NFR-T3 | The pure domain code (detectors, money arithmetic, reconciliation, the grounding checker) is at least 95% on all four measures. |
| NFR-T4 | Three layers: unit tests for domain code; integration tests that run the agent and the workflow inside the Workers runtime with a mocked model; end-to-end browser tests for UC-1, UC-3, UC-6, UC-9 and UC-10. |
| NFR-T5 | Grounding evaluations run against the real model before each release. Cases where fabrication is possible must pass in three of three runs. Capability cases must pass in at least one of three runs for 90% of cases. |
| NFR-T6 | No skipped tests on the main branch. Unit tests finish in under 30 seconds. Tests are independent and build their own data. |

### TypeScript code quality

| ID | Requirement |
| --- | --- |
| NFR-Q1 | Strict TypeScript, with unchecked index access disallowed. No `any`, no non-null assertions, no `@ts-ignore`. |
| NFR-Q2 | Every boundary is validated with a schema: tool inputs, external API responses, workflow parameters, rows read from SQLite. Types are inferred from the schemas. |
| NFR-Q3 | Money is integer minor units under a branded type. No floating-point arithmetic on money. |
| NFR-Q4 | States are discriminated unions with exhaustive handling. Expected failures are returned as typed results; exceptions are for bugs. |
| NFR-Q5 | Data is not mutated in place. Functions stay under 50 lines and files under 400. No unexplained literals. |
| NFR-Q6 | Formatter, linter and type check pass with zero warnings in CI. |

### Security and operation

| ID | Requirement |
| --- | --- |
| NFR-S1 | Only the authenticated account owner reaches the agent. A client cannot select another account's agent. This holds from the first deployment, on every hostname the Worker answers on. |
| NFR-S2 | The Cloudflare API token is read-only for billing, stored as a Worker secret, and never sent to the model, the browser or the logs. |
| NFR-S3 | The agent has read-only access to the Cloudflare account and takes no action outside its own database. Finalizing a close needs an approval action in the UI; no model-callable tool performs it. |
| NFR-S4 | All SQL is parameterized. The Worker exposes no unauthenticated route. |
| NFR-S5 | Every close approval or rejection, every credit draft and every owner-reported outcome is written to an append-only audit table. |
| NFR-O1 | Workflow steps are idempotent. A retried step does not write a second snapshot or close a period twice. |
| NFR-O2 | The first token of a chat answer streams within 5 seconds at the median (target, measured in the evaluation run). |
| NFR-O3 | The daily neuron budget (UC-8) is enforced in code before each model call. |

### Deployment

| ID | Requirement |
| --- | --- |
| NFR-D1 | Every build phase ends deployed to Cloudflare, first to staging and then to production, with the automated smoke test passing on each. Work on the next phase does not start before that. CI enforces the gate. |
| NFR-D2 | Deployment is one scripted, repeatable command that builds, deploys, runs the smoke test and records the result. Until the deploy token is connected to GitHub it is run from the developer's machine with the Wrangler login; after that CI runs the same command. No deployment bypasses the script. |
| NFR-D3 | The smoke test runs against the deployed URL after every deployment. It proves the deployed version is the intended commit, that unauthenticated access is refused, and that one chat turn completes. Each phase adds a check for what it built. |
| NFR-D4 | A failed staging smoke test blocks production. A failed production smoke test triggers a rollback. |
| NFR-D5 | The deployment cycle is tested and hardened in the first phase, before any feature work: rollback, a blocked bad deploy, a data-preserving schema change and a missing-secret failure are each exercised once and recorded. |
| NFR-D6 | Schema changes are additive and work with the previous code version, so a rollback never meets a schema it cannot read. |
| NFR-D7 | Each deployment is recorded in the repo: phase, date, commit, version, smoke result. |

## 9. Exercise criteria

The project is built for an exercise with the criteria below. This section maps each one to the spec and was last checked on 2026-10-05.

| Criterion | How the spec meets it | State |
| --- | --- | --- |
| An LLM; Llama 3.3 on Workers AI is recommended | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI, for every chat turn and tool call. | Built and deployed. |
| Workflow or coordination; Workflows, Workers or Durable Objects are recommended | A Durable Object per account coordinates the chat, tools, state and schedules. A Cloudflare Workflow runs the invoice close with a durable approval gate (UC-6). A Worker routes and authenticates. | The Durable Object and Worker are built and deployed. The Workflow arrives in phase 7. |
| User input by chat or voice; Pages or Realtime are recommended | A chat interface over WebSocket, from the official agents starter. It is served as static assets of the same Worker, not from Pages. There is no voice input. | Built and deployed. |
| Memory or state | The Durable Object's SQLite holds chat history, the cost meter, and later usage, invoices, credit drafts and closes. Agent state is synced to the browser. | Chat history and the meter are built and deployed. The rest follows by phase. |
| AI-assisted coding is allowed, but the prompt history must be submitted | Not yet covered. See NFR-P1. | Open. |

Two points to keep in view:

- If the exercise is submitted before phase 7, the Workflow is not yet in the product. The coordination criterion is still met by the Durable Object and Worker, which the criterion names as alternatives.
- The chat is not hosted on Pages. The criterion recommends Pages but does not require it.

### Prompt history

| ID | Requirement |
| --- | --- |
| NFR-P1 | The prompts given to the AI coding assistant are kept in the repository in a single file, in order, and brought up to date at the end of each phase. They contain no secrets or account identifiers. |

## 10. Open questions

Each has the default this spec assumes. The low-level spec is written against the defaults.

| # | Question | Default assumed |
| --- | --- | --- |
| Q1 | Is "documentation on the web" limited to Cloudflare's docs? | Yes. |
| Q2 | Which plans and products does the price table cover? | Workers Free and Workers Paid only. |
| Q3 | Does the invoice close start on a schedule or on request? | On request in chat. |
| Q4 | Does "rate" re-price usage independently, or total the costs the API reports? | It totals the API-reported costs and reconciles with the invoice. |


### Decided

| Date | Decision |
| --- | --- |
| 2026-10-04 | Credit requests are drafted and handed to the owner with submission instructions. The agent does not submit. |
| 2026-10-04 | Single account per deployment. |
| 2026-10-04 | Attributing a spike to a specific Worker script is not in v1. |
| 2026-10-04 | The assistant meters, reports and caps its own cost (UC-8). |
| 2026-10-05 | v1 starts on the current $0 account. Bill explanations, the invoice close and plan comparison are proven on fixture data through test mode (UC-10) until the account has charges; they are re-checked on live data when it does. |
| 2026-10-05 | Usage quantities come from the GraphQL Analytics API; costs and invoices come from the billing API. Tested on the real account. |
| 2026-10-04 | A $0 account is a valid account. The usage summary is part of the interface and shows usage and billing per product regardless of the bill (UC-9). |
| 2026-10-04 | Every phase is deployed to Cloudflare before the next begins; the deployment cycle is hardened during scaffolding (NFR-D1 to D7). |

## 11. Future backlog

Not in v1. Each item names what it would need.

| Item | Needs |
| --- | --- |
| Attribute a spike to a specific Worker script | The Workers dataset in the GraphQL Analytics API has a script name dimension, seen in the schema on this account. Not yet queried with data. It covers Workers requests and CPU, not other products. |
| Submit credit requests and show Cloudflare's decision in chat (UC-5) | A submission channel and a way to receive decisions. Cloudflare has no public API for either. |
| Multiple accounts or users | A login and account-mapping design in place of the single Access-protected deployment. |
| Search beyond Cloudflare's documentation | A general web search tool and rules for which sources count under G-2. |
| Scheduled monthly close | The billing cycle anchor day from the usage API. |
| Independent re-pricing of usage | A full price catalog. |
| Independent check of the meter through a dedicated AI Gateway | AI Gateway pricing and setup, not yet verified. |

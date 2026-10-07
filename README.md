# cf-invoice-buddy
Experimental AI bot that runs on Cloudflare and explains why the invoice is what it is.

Specs are in [spec/](spec/).

What the project has learned about Cloudflare's platform, from Workers AI limits and stream quirks to AI Gateway caching, the usage APIs and Workflows, is kept in a skill file for coding agents: [.claude/skills/cloudflare-platform-notes/SKILL.md](.claude/skills/cloudflare-platform-notes/SKILL.md). It is worth reading for people too. [AGENTS.md](AGENTS.md) tells agents when to use it.

## Implementation status

Last updated 2026-10-07. The build follows nine phases set out in [spec/low-level.md](spec/low-level.md), section 15. Each phase must be deployed to Cloudflare and pass a smoke test before the next begins.

**Phases 1 to 7 of 9 are done.** A phase is done when it runs in staging and production behind Cloudflare Access and both environments pass the smoke test. Full test run takes a significant amount of daily neurons and production deployments with full end to end test pass can be done ~1 a day.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Scaffold, authentication, the assistant's own cost meter and budget, deployment cycle | Done |
| 2 | Billing domain logic: money, periods, breakdowns, anomaly detectors | Done |
| 3 | Usage data, usage summary panel, test mode | Done |
| 4 | Bill explanations and the assistant's cost report | Done |
| 5 | Documentation search and grounding checks, with each reply held until it is checked | Done |
| 6 | Credit request drafts, history and owner-reported outcomes | Done |
| 7 | Monthly invoice close, run as a Workflow with an owner approval gate | Done |
| 8 | Plan comparison: an estimate of the month's usage on Workers Free and Workers Paid | Code complete; not yet deployed |
| 9 | Release | Not started |

What works today, in both deployed environments:

- **Chat.** An agent on Llama 3.3 over the starter chat UI. Each reply is held until it has been checked against the account's data, and is shown only if every figure and link in it came from a tool result.
- **Usage summary.** A panel that is always on screen: what each product used this period, against its included allowance, and what was billed. It works on an account with a $0 bill.
- **Bill explanations.** A month's bill against a baseline, per product and per day, with causes stated only when a detector found them in the account's data or a Cloudflare documentation page describes them. When neither holds, the agent says it cannot explain the difference.
- **Credit requests.** A draft built from the account's data with a fixed template, with the steps for submitting it yourself. The agent submits nothing. Drafts are kept, and what you report about them is stored as your report.
- **Invoice close.** A Cloudflare Workflow freezes a finished month's usage, totals it per product, reconciles it with the invoice, checks it for anomalies, and waits for your decision. Only the Approve and Reject buttons in the approval card decide; the model cannot. A closed month is final.
- **The assistant's own cost.** A meter of its model usage, a daily budget, and a cost report.
- **Test mode.** Five fixture accounts the owner can switch to and back. Fixture figures are always labelled, and never mixed with live ones.
- **Access.** Sign-in through Cloudflare Access, and a lock so only the account's own agent instance can be reached.
- **Checks.** Over 500 automated tests, format, lint, type check and build, run by CI on every pull request and push.
- **Deploys.** One command per environment, with a smoke test that checks the deployed app against the account's data and the Worker's logs, and rolls production back if it fails. The record is in [spec/deployments.md](spec/deployments.md).

Deploys run from a developer machine until a deploy token is added to GitHub.


## Cloudflare API token for usage and billing data

The app reads your account's usage and invoices through the Cloudflare API. It needs its own API token. Being logged in to the `cf` or `wrangler` CLI is not enough: those logins do not include billing access, and a deployed Worker cannot use them.

### Before you start

- You must be a Super Administrator of the account, or have API token provisioning rights. A token can only be given permissions you hold yourself.
- Cloudflare's billable usage data covers pay-as-you-go accounts with a usage-based subscription, such as Workers Paid. On an account with no such subscription the API may return nothing. To check what Cloudflare has for your account, open **Manage Account > Billing > Billable Usage** in the dashboard.

### Create the token

1. In the Cloudflare dashboard, select your account and go to **Manage Account > Account API tokens**.
2. Select **Create Token** and choose a custom token.
3. Name it, for example `cf-invoice-buddy read-only`.
4. Add two account permissions:
   - **Billing: Read** for usage, costs and invoices.
   - **Account Analytics: Read** for per-product usage from the GraphQL Analytics API.
5. Limit the token's resources to this one account.
6. Optionally set an expiry date.
7. Select **Continue to summary**, then **Create Token**.
8. Copy the token secret. It is shown once.

Do not add any write permission. The app never changes your account.

### Check the token

```sh
export CF_ACCOUNT_ID=<your account id>
export CF_API_TOKEN=<the token secret>

curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/billable-usage" \
  --header "Authorization: Bearer $CF_API_TOKEN"
```

A response with `"success": true` means the permission works, even if the result list is empty. A 403 means the token lacks **Billing: Read**.

### Give the token to the app

Locally, put it in `.dev.vars` next to the Wrangler configuration, as described under "Setting up Wrangler" below. The file must be .gitignored.

```
CF_ACCOUNT_ID=<your account id>
CF_API_TOKEN=<the token secret>
```

For a deployed environment, put it in that environment's secrets file, described under "Deploying" below.

### Known limitations

Cloudflare has a newer usage endpoint (`/accounts/{id}/billable/usage`) that reports daily usage including free-tier amounts. It is marked alpha and restricted. A token with the permissions above may still get a 403 from it; access is granted by Cloudflare, not by a token setting.

## Setting up Wrangler

Wrangler is Cloudflare's command-line tool. It is installed with the project's other dependencies, so there is nothing to install globally. Its configuration file, `wrangler.jsonc`, is not in the repository and must be .gitignored: you create your own from the template.

1. Install the dependencies, which include Wrangler:

   ```sh
   npm install
   ```

2. Sign in to the Cloudflare account the app will run in, and check which account Wrangler sees:

   ```sh
   npx wrangler login
   npx wrangler whoami
   ```

   The login opens a browser. It is used for deploying and for local development; the app itself reads usage and billing with the API token described above, not with this login.

3. Create your configuration from the template:

   ```sh
   cp wrangler.example.jsonc wrangler.jsonc
   ```

4. Edit `wrangler.jsonc` if your account needs it:

   | Setting | When to change it |
   | --- | --- |
   | `name` at the top and under `env.staging` and `env.production` | The Worker names, which become the `workers.dev` hostnames. If you change them, change `WORKER_NAMES` in `scripts/lib.mjs` to match. |
   | `DAILY_NEURON_BUDGET`, `SMOKE_DAILY_NEURON_BUDGET` | The model budget of each environment. The six values must add up to no more than 9,000; a test checks this. |
   | `compatibility_date` | Only when upgrading the Workers runtime. |
   | `AI_GATEWAY_ID`, `SMOKE_MODEL_ID` | Optional and empty by default. They make the smoke test cheaper; see spec/low-level.md, section 10. `AI_GATEWAY_ID` is the name of an AI Gateway you have created in your account with caching on. |

   Do not put secrets in this file. They go in `.dev.vars` for local development and in `.secrets/` for deployed environments, both described in this README.

5. Regenerate the binding types after any change to the file:

   ```sh
   npm run types
   ```

6. Put your account ID and API token in `.dev.vars`, next to `wrangler.jsonc`, as described under "Give the token to the app" above.

When a change to the configuration is meant for everyone, make it in `wrangler.example.jsonc` as well, since that is the file in git and the one CI uses.

## Workflows

The monthly invoice close runs as a [Cloudflare Workflow](https://developers.cloudflare.com/workflows/), a durable, multi-step program that can wait for days and survive restarts.

**You do not create it.** Each environment's Workflow is declared in the `workflows` entry of the Wrangler configuration, and `wrangler deploy` creates it on the first deploy, the same way it creates the agent's Durable Object. Staging and production each get their own (`invoice-close-staging` and `invoice-close`), so they never share a close. Workflows are available on the Workers Free plan.

How a close works:

1. You ask in chat to close a month. Only a month that has ended can be closed; with no month named, it is the last finished one.
2. The Workflow freezes that month's usage, so later data cannot change the close.
3. It totals the frozen usage per product and reconciles the total with the invoice.
4. It runs the same anomaly detectors a bill explanation uses.
5. It waits for you, for up to seven days. An approval card appears above the chat with the line items, the reconciliation and anything the detectors found.
6. **Approve** closes the month for good: its figures are final and it cannot be closed again. **Reject**, or no decision in seven days, leaves the month open, and the close can be started again.

Only the buttons in the approval card can approve or reject. The assistant can start a close and tell you its state, but it has no way to approve one, and a reply in which it claims to have done so is withheld.

Each step does its work in the agent's own database and is safe to run twice, so a retried step never writes a second snapshot or closes a month twice. The close's result is kept by the agent, because on the Free plan Cloudflare keeps a finished Workflow instance for only three days.

In test mode a close runs on fixture data, is labelled as such, and closes no real period. Your Workflows and their runs are listed in the Cloudflare dashboard, in the Workflows section.

## Developing

```sh
npm run dev            # local app against the real model; see the note below
npm run check          # format, lint, type check
npm run test:coverage  # unit and integration tests with coverage thresholds
npm run eval           # whole evaluation suite against the real model; needs `npm run dev` running
npm run eval -- --changed   # only the cases affected by changes since origin/main
npm run record         # record the real model's answers for the replay tests; see spec/low-level.md, section 10
```

Local development reaches the real model through the production Worker's hostname, which Cloudflare Access protects. Run `npm run dev` in a terminal and sign in when the browser prompt appears, or set `CLOUDFLARE_ACCESS_CLIENT_ID` and `CLOUDFLARE_ACCESS_CLIENT_SECRET` to an Access service token for non-interactive use.

### Staying inside the free tier

The app runs on Cloudflare's free plan, where Workers AI allows 10,000 neurons a day for the whole account. Each agent instance has a budget in `wrangler.jsonc` (and in the template, `wrangler.example.jsonc`), counted over the trailing 24 hours; together they add up to 9,000, and a test fails if that total is raised past the allowance. Cloudflare documents a reset at 00:00 UTC, but it has refused calls over usage from the previous day, so the app counts the trailing 24 hours to be safe. A chat turn that goes in circles is stopped, and the smoke test, which makes one model turn per run, will not run if it would take the account past 8,000 neurons in the trailing 24 hours.

## Deploying

There are two environments, `staging` and `production`. Both are deployed by one script, which builds, deploys, runs a smoke test against the live URL and records the result. It refuses a working tree with uncommitted changes and a commit that is not on `origin/main`. It also needs your `wrangler.jsonc`; because that file is not in git, the script says so when it differs from the template. Production also requires that the same commit has passed staging.

```sh
npm run deploy:staging
npm run deploy:production
```

The first deploy of a new environment is `node scripts/deploy.mjs <env> --bootstrap`. It uploads the Worker with a placeholder `ACCESS_AUD`, so every request is refused, and exists only to create the hostname for the Access application.

Secrets are read from files in `.secrets/`, which must be .gitignored:

| File | Contents |
| --- | --- |
| `.secrets/staging.env`, `.secrets/production.env` | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` |
| `.secrets/smoke.env` | `SMOKE_URL_STAGING`, `SMOKE_URL_PRODUCTION`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |

Each environment sits behind a Cloudflare Access application on its `workers.dev` hostname. `ACCESS_AUD` is that application's audience tag, and the smoke test signs in with an Access service token.

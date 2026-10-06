# cf-invoice-buddy
Experimental AI bot that runs on Cloudflare and explains why the invoice is what it is.

Specs are in [spec/](spec/).

## Implementation status

Last updated 2026-10-06. The build follows nine phases set out in [spec/low-level.md](spec/low-level.md), section 15. Each phase must be deployed to Cloudflare and pass a smoke test before the next begins.

**Phases 1 to 4 of 9 are deployed.** They run in staging and production behind Cloudflare Access, and both environments pass the smoke test. Phase 5 is merged and uploaded to staging but not yet verified or in production: Cloudflare is refusing model calls for the account until its free daily allowance resets.

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Scaffold, authentication, the assistant's own cost meter and budget, deployment cycle | Deployed to staging and production; hardening drills passed |
| 2 | Billing domain logic: money, periods, breakdowns, anomaly detectors | Deployed. The logic is tested but not yet used by the agent |
| 3 | Usage data, usage summary panel, test mode | Deployed |
| 4 | Bill explanations and the assistant's cost report | Deployed |
| 5 | Documentation search and grounding checks | Code complete and merged; deploy waiting on the model allowance |
| 6 | Credit request drafts | Not started |
| 7 | Monthly invoice close | Not started |
| 8 | Plan comparison | Not started |
| 9 | Release | Not started |

What works today, in both deployed environments:

- A chat agent on Llama 3.3 over the starter chat UI. It reports the account's usage from real data and explains a month's bill against a baseline, stating only causes found in the account's data.
- A usage summary panel, always on screen: what each product used this period, against its included allowance, and what was billed. It works on an account with a $0 bill.
- Test mode: the owner can switch to one of four fixture accounts and back. A switch asked for in chat needs the owner's confirmation.
- Sign-in enforcement through Cloudflare Access tokens, and a lock so only the account's own agent instance can be reached.
- The cost meter and daily budget.
- The billing logic the later phases build on: breakdowns against a baseline, eight anomaly detectors and invoice reconciliation. The agent does not call it yet.
- A bill breakdown card and the assistant's own cost report and running meter.
- 277 automated tests, format, lint, type check and build, run by CI on every pull request.
- One-command deploys with a smoke test that asks real usage and bill questions, checks the answers against the data, and checks the Worker's logs. The record is in [spec/deployments.md](spec/deployments.md).

Deploys run from a developer machine until a deploy token is added to GitHub.


## Cloudflare API token for usage and billing data

The app reads your account's usage and invoices through the Cloudflare API. It needs its own API token. Being logged in to the `cf` or `wrangler` CLI is not enough: those logins do not include billing access, and a deployed Worker cannot use them.

> Status: a token created this way was tested on 2026-10-05. It read billing data and, through the GraphQL Analytics API, real per-product usage on an account with a $0 bill.

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

Locally, put it in `.dev.vars` next to the Wrangler configuration. The file is git-ignored.

```
CF_ACCOUNT_ID=<your account id>
CF_API_TOKEN=<the token secret>
```

For a deployed environment, put it in that environment's secrets file, described under "Deploying" below.

### Known limit

Cloudflare has a newer usage endpoint (`/accounts/{id}/billable/usage`) that reports daily usage including free-tier amounts. It is marked alpha and restricted. A token with the permissions above may still get a 403 from it; access is granted by Cloudflare, not by a token setting.

## Developing

```sh
npm install
npm run dev            # local app against the real model; see the note below
npm run check          # format, lint, type check
npm run test:coverage  # unit and integration tests with coverage thresholds
npm run eval           # evaluation suite against the real model; needs `npm run dev` running
```

Local development reaches the real model through the production Worker's hostname, which Cloudflare Access protects. Run `npm run dev` in a terminal and sign in when the browser prompt appears, or set `CLOUDFLARE_ACCESS_CLIENT_ID` and `CLOUDFLARE_ACCESS_CLIENT_SECRET` to an Access service token for non-interactive use.

Keep the repository out of folders that iCloud Drive syncs, such as `~/Documents` or the Desktop when "Desktop & Documents Folders" is on. iCloud makes numbered conflict copies (`file 2.ts`) of files that change quickly, including inside `.git` and `node_modules`. `.gitignore` ignores such copies, but they still break local type checks and can corrupt the repository's refs.

### Staying inside the free tier

The app runs on Cloudflare's free plan, where Workers AI allows 10,000 neurons a day for the whole account. Each agent instance has a daily budget in `wrangler.jsonc`; together they add up to 9,000, and a test fails if that total is raised past the allowance. A chat turn that goes in circles is stopped, and the smoke test, which makes one model turn per run, will not run if it would take the account past 8,000 neurons for the day.

## Deploying

There are two environments, `staging` and `production`. Both are deployed by one script, which builds, deploys, runs a smoke test against the live URL and records the result. It refuses a working tree with uncommitted changes and a commit that is not on `origin/main`. Production also requires that the same commit has passed staging.

```sh
npm run deploy:staging
npm run deploy:production
```

The first deploy of a new environment is `node scripts/deploy.mjs <env> --bootstrap`. It uploads the Worker with a placeholder `ACCESS_AUD`, so every request is refused, and exists only to create the hostname for the Access application.

Secrets are read from files in `.secrets/`, which is git-ignored:

| File | Contents |
| --- | --- |
| `.secrets/staging.env`, `.secrets/production.env` | `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` |
| `.secrets/smoke.env` | `SMOKE_URL_STAGING`, `SMOKE_URL_PRODUCTION`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` |

Each environment sits behind a Cloudflare Access application on its `workers.dev` hostname. `ACCESS_AUD` is that application's audience tag, and the smoke test signs in with an Access service token.

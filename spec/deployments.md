# Deployment record

Kept under NFR-D7. The hardening drills were run and written up by hand. The deployments table is last in the file because `scripts/deploy.mjs` appends a row to the end after each deployment that passes its smoke test.

## Hardening drills

| Drill | When (UTC) | Result | Commands |
| --- | --- | --- | --- |
| Rollback | 2026-10-05 | Passed. After `wrangler rollback`, the smoke test passed against the previous commit, 5 of 5. | `npm run deploy:staging`; `npx wrangler rollback --name cf-invoice-buddy-staging --yes`; `node scripts/smoke.mjs staging <previous sha>` |
| Schema change over existing data, then code rollback | 2026-10-05 | Passed. Migration 2 (audit log) was deployed over a database with meter rows. The rolled-back code ran against the newer schema and metered a turn. The day's meter total carried across every deploy and the rollback (39.31, then 49.82, then 61.40 neurons). | Same as above, on the commit that added migration 2 |
| Blocked bad deploy | 2026-10-05 | Passed. With the staging smoke test failing (4 of 5), no `staging-ok` tag was written and `npm run deploy:production` refused with "This commit has not passed the staging smoke test." | `SMOKE_URL_STAGING=<wrong target> npm run deploy:staging`; `npm run deploy:production` |
| Missing secret | 2026-10-05 | Passed. With `ACCESS_AUD` deleted, the smoke test failed 1 of 5 with HTTP 500, and the response body named the variable: `{"configOk":false,"invalid":["ACCESS_AUD"]}`. The next deploy restored it. | `npx wrangler secret delete ACCESS_AUD --name cf-invoice-buddy-staging`; `node scripts/smoke.mjs staging <sha>`; `npm run deploy:staging` |
| Pipeline twice from a clean checkout | 2026-10-05 | Passed on the second run; the first exposed a flaw, since fixed. Run 1 failed 4 of 5: the first WebSocket connection after the deploy failed. Run 2 passed 5 of 5. The smoke test now retries a failed connection. | `git clone`; copy `.secrets/`; `npm ci`; `npm run deploy:staging` twice |
| Automatic production rollback | 2026-10-05 | Passed. A production deploy whose smoke test failed (4 of 6) was rolled back by the script to the previous version. Production then passed the smoke test against the previous commit, 6 of 6, and the `deployed/phase-1` tag did not move. | `SMOKE_URL_PRODUCTION=<wrong target> npm run deploy:production`; `node scripts/smoke.mjs production <previous sha>` |

Two flaws found by the drills and fixed in the smoke test: it now waits for the intended commit to be served before judging a deploy (a deploy straight after a rollback served the old commit for a moment), and it retries a failed WebSocket connection.

The smoke test also follows the Worker's live logs during the run and fails on a failed invocation, an uncaught exception or an error-level log line. Peak CPU per invocation in these runs was 29 to 108 ms.

## Deployments

Every deployment that passed its smoke test, oldest first. Failed and drill deployments are not listed. Four phase 1 rows were lost when this file was reorganised and were rebuilt from the saved deploy logs; their times are when each log was last written.

| Phase | When (UTC) | Environment | Commit | Smoke test |
| --- | --- | --- | --- | --- |
| 1 | 2026-10-05T03:19:19.902Z | staging | 42948fd0f237 | passed |
| 1 | 2026-10-05T03:19:51.056Z | staging | d7c72e46b55d | passed |
| 1 | 2026-10-05T03:20:14.946Z | production | d7c72e46b55d | passed |
| 1 | 2026-10-05T03:21:45.930Z | staging | 601eac8bd69e | passed |
| 1 | 2026-10-05T03:23:26.290Z | staging | ce101ea14f27 | passed |
| 1 | 2026-10-05T03:26:42Z | staging | e1e4626fefb9 | passed (row rebuilt from the deploy log) |
| 1 | 2026-10-05T03:27:05Z | production | e1e4626fefb9 | passed (row rebuilt from the deploy log) |
| 1 | 2026-10-05T03:40:19Z | staging | 5c59c41ec0df | passed (row rebuilt from the deploy log) |
| 1 | 2026-10-05T03:42:39Z | production | 5c59c41ec0df | passed (row rebuilt from the deploy log) |
| 2 | 2026-10-05T03:57:15.633Z | staging | d2edabbdd3ec | passed |
| 2 | 2026-10-05T03:57:55.736Z | production | d2edabbdd3ec | passed |
| 3 | 2026-10-05T04:17:09.637Z | staging | 3eba70f786b6 | passed |
| 3 | 2026-10-05T04:18:06.720Z | production | 3eba70f786b6 | passed |

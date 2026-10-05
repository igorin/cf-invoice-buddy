# cf-invoice-buddy
Experimental AI bot that runs on Cloudflare and explains why the invoice is what it is.

Specs are in [spec/](spec/).

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

For a deployed environment, store it as a Worker secret:

```sh
npx wrangler secret put CF_API_TOKEN --env production
```

### Known limit

Cloudflare has a newer usage endpoint (`/accounts/{id}/billable/usage`) that reports daily usage including free-tier amounts. It is marked alpha and restricted. A token with the permissions above may still get a 403 from it; access is granted by Cloudflare, not by a token setting.

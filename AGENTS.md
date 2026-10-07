# Cloudflare Workers

STOP. Your knowledge of Cloudflare Workers APIs and limits may be outdated. Always retrieve current documentation before any Workers, KV, R2, D1, Durable Objects, Queues, Vectorize, AI, or Agents SDK task.

## Project knowledge: read this first

This project keeps what it has observed about Cloudflare's platform in [.claude/skills/cloudflare-platform-notes/SKILL.md](.claude/skills/cloudflare-platform-notes/SKILL.md): Workers AI limits, pricing and stream behaviour, AI Gateway caching, the Agents SDK, Workflows, the billing and analytics APIs, Access, Wrangler and testing.

- **Look there before you design, debug or test** anything that touches those. Many entries record behaviour that differs from what the documentation suggests, with the date it was seen.
- **Each entry is marked** Observed, Documented or Open. Do not design on an Open entry without a live check.
- **If Cloudflare's current documentation explicitly contradicts an entry, update the file.** Change the entry to say what the documentation now states, with the page and the date you read it, and mark it Documented until it has been seen on the platform. Do not delete an Observed entry because the documentation disagrees: keep what was observed, with its date, next to what the documentation says, so the difference is visible.
- **Add to it** when you learn something about the platform that cost time to find out. Mark it Observed only if you saw it happen.

## Specs

The specs in [spec/](spec/) describe what the system does. Two rules, also in [spec/README.md](spec/README.md):

- **Update the body of the spec in the same change as the code.** Do not append notes about how the build differs from the spec.
- **Before a significant addition or change to the scope, archive the current spec**: copy `high-level.md` and `low-level.md` into `spec/archived/<date>-<name>/` and add a row to `spec/archived/README.md`.

## Docs

- https://developers.cloudflare.com/workers/
- MCP: `https://docs.mcp.cloudflare.com/mcp`

For all limits and quotas, retrieve from the product's `/platform/limits/` page. eg. `/workers/platform/limits`

## Commands

| Command | Purpose |
|---------|---------|
| `npx wrangler dev` | Local development |
| `npx wrangler deploy` | Deploy to Cloudflare |
| `npx wrangler types` | Generate TypeScript types |

Run `wrangler types` after changing bindings in wrangler.jsonc. That file is git-ignored; change `wrangler.example.jsonc` too when the change is for everyone.

## Local Explorer (Debugging & Inspection)

When running `npx wrangler dev`, a Local Explorer API is available for inspecting and debugging local Workers, bindings, and storage state. The API base URL is printed in the terminal when the dev server starts.

Key endpoints (relative to the dev server URL):

| Endpoint | Description |
|----------|-------------|
| `GET /cdn-cgi/local/explorer/api/local/workers` | List local Workers and their bindings |
| `GET /cdn-cgi/local/explorer/api/storage/kv/namespaces` | List KV namespaces |
| `GET /cdn-cgi/local/explorer/api/d1/database` | List D1 databases |
| `GET /cdn-cgi/local/explorer/api/r2/buckets` | List R2 buckets |
| `GET /cdn-cgi/local/explorer/api/workers/durable_objects/namespaces` | List Durable Object namespaces |
| `GET /cdn-cgi/local/explorer/api/workflows` | List Workflows |
| `POST /cdn-cgi/local/explorer/api/local/observability/query` | Run a read-only SQL query (SELECT/WITH only) over captured request traces and console logs. Tables: `spans`, `logs` (read attributes via `json(attributes)`). Example: `curl -X POST <base>/cdn-cgi/local/explorer/api/local/observability/query -H 'Content-Type: application/json' -d '{"sql":"SELECT service, name, outcome, duration_ms FROM spans WHERE parent_id IS NULL LIMIT 20"}'` |
| `POST /cdn-cgi/local/explorer/api/local/observability/clear` | Clear all captured traces and logs |

If the routes above don't cover what you need, fetch the full OpenAPI schema (large - use only as a last resort): `GET /cdn-cgi/local/explorer/api`

Use the Local Explorer to debug issues by inspecting storage state (KV keys, D1 rows, R2 objects, DO storage), viewing Worker bindings, and querying request traces and logs captured during the dev session.

## Node.js Compatibility

https://developers.cloudflare.com/workers/runtime-apis/nodejs/

## Errors

- **Error 1102** (CPU/Memory exceeded): Retrieve limits from `/workers/platform/limits/`
- **All errors**: https://developers.cloudflare.com/workers/observability/errors/

## Product Docs

Retrieve API references and limits from:
`/kv/` · `/r2/` · `/d1/` · `/durable-objects/` · `/queues/` · `/vectorize/` · `/workers-ai/` · `/agents/`

## Best Practices (conditional)

If the application uses Durable Objects or Workflows, refer to the relevant best practices:

- Durable Objects: https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
- Workflows: https://developers.cloudflare.com/workflows/build/rules-of-workflows/

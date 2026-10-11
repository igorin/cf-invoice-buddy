import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const ENVIRONMENTS = ["staging", "production"];

export const WORKER_NAMES = {
  staging: "cf-invoice-buddy-staging",
  production: "cf-invoice-buddy"
};

/** Runs a command and returns its trimmed stdout. Throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const output = execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options
  });
  // With inherited stdio there is no captured output.
  return (output ?? "").trim();
}

/** Reads KEY=VALUE lines from a file. Values are never logged by callers. */
export function readEnvFile(path) {
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    });
  return Object.fromEntries(entries);
}

export function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

export function currentPhase() {
  const phase = Number(readFileSync(".phase", "utf8").trim());
  if (!Number.isInteger(phase) || phase < 1)
    fail(".phase must hold a phase number");
  return phase;
}

/** The window Cloudflare's neuron limit is counted over here; see below. */
export const WINDOW_HOURS = 24;

/**
 * The account's Workers AI neurons over the trailing 24 hours, from GraphQL
 * Analytics. Cloudflare documents a limit that resets at 00:00 UTC, but on
 * 2026-10-06 it refused calls over usage made the day before, so the check
 * uses the trailing 24 hours, which is never looser than the calendar day.
 */
export async function accountNeuronsLast24Hours() {
  const credentials = { ...readEnvFile(".dev.vars"), ...process.env };
  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_HOURS * 3_600_000);
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${credentials.CF_API_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      query: `query($account: String!, $since: Time!, $until: Time!) { viewer { accounts(filter: { accountTag: $account }) {
        rows: aiInferenceAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_leq: $until }) { sum { totalNeurons } }
      } } }`,
      variables: {
        account: credentials.CF_ACCOUNT_ID,
        since: since.toISOString(),
        until: now.toISOString()
      }
    })
  });
  const body = await response.json();
  const rows = body.data?.viewer?.accounts?.[0]?.rows;
  if (!response.ok || !Array.isArray(rows)) {
    throw new Error("the account's neuron usage could not be read");
  }
  return rows.reduce((total, row) => total + (row.sum?.totalNeurons ?? 0), 0);
}

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

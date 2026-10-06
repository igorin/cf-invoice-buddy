import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LLAMA_3_3_PRICE } from "../../src/domain/self-cost";

/**
 * The project must stay inside Cloudflare's free tier. Workers AI gives the
 * whole account 10,000 neurons a day, shared by production, staging, their
 * smoke-test instances and local development. Each agent instance enforces
 * its own budget, so the budgets together must fit.
 */

// Leaves room for the odd direct model call made outside the app.
const HEADROOM_NEURONS = 1_000;

function budgetsIn(config: string): number[] {
  const pattern = /"(?:SMOKE_)?DAILY_NEURON_BUDGET":\s*"(\d+)"/g;
  return [...config.matchAll(pattern)].map((match) => Number(match[1]));
}

// The committed template, and the local configuration that deploys use.
const CONFIG_FILES = ["wrangler.example.jsonc", "wrangler.jsonc"].filter(
  (file) => existsSync(file)
);

describe.each(CONFIG_FILES)("daily neuron budgets in %s", (file) => {
  const budgets = budgetsIn(readFileSync(file, "utf8"));

  it("are set for the owner and smoke instances of all three environments", () => {
    expect(budgets).toHaveLength(6);
    expect(budgets.every((budget) => budget > 0)).toBe(true);
  });

  it("add up to no more than the free daily allowance, with headroom", () => {
    const total = budgets.reduce((sum, budget) => sum + budget, 0);
    expect(total).toBeLessThanOrEqual(
      LLAMA_3_3_PRICE.freeNeuronsPerDay - HEADROOM_NEURONS
    );
  });
});

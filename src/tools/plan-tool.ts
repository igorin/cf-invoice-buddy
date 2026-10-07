import { tool } from "ai";
import { z } from "zod";
import type { InvoiceBuddyAgent } from "../agent";
import type { PlanComparisonView } from "../services/plan-service";

/** The plan comparison tool (spec UC-7). It reads; it changes nothing. */

export function describePlansForModel(view: PlanComparisonView) {
  const { dataset, scenario, estimate: _estimate, ...comparison } = view;
  return {
    dataset,
    notice:
      dataset === "test"
        ? `TEST DATA from scenario "${scenario}". Say so whenever you state a figure from this result.`
        : "Live account data.",
    instruction:
      'Every amount here is an estimate at list price: use the word "estimate" when you state one. Give the verdict as written. Do not recommend a plan or say which is better beyond what the verdict states, and do not change plans: you cannot. If notPriced is not empty, say that usage is left out of the totals. The full comparison is shown in a card; do not repeat its table.',
    ...comparison
  };
}

export function buildPlanTools(agent: InvoiceBuddyAgent) {
  return {
    comparePlans: tool({
      description:
        "Estimate what a month's actual usage would cost on Workers Free and on Workers Paid, from list prices. Use when the owner asks whether another plan would be cheaper or what a plan would cost.",
      // Loose for the same reason as explainBillChange: see tools/index.ts.
      inputSchema: z.object({
        month: z.string().nullish().describe("YYYY-MM. Omit for this month.")
      }),
      execute: async ({ month }) =>
        describePlansForModel(await agent.comparePlans(month ?? undefined))
    })
  };
}

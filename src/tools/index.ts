import { tool } from "ai";
import { z } from "zod";
import type { InvoiceBuddyAgent } from "../agent";
import { SPECULATION_LABEL } from "../domain/grounding";
import { SCENARIOS, isScenarioId } from "../domain/scenarios";
import {
  MONTH_PATTERN,
  type ExplainRequest
} from "../services/explain-service";
import { describeForModel } from "./explain-tool";
import { describeSummaryForModel } from "./usage-summary-tool";

/**
 * The tools the model may call. None changes anything outside the agent's
 * own database, and the only one with a lasting effect, setDataMode, pauses
 * for the owner's approval before it runs (spec NFR-S3, UC-10).
 */
type ExplainInput = Readonly<{
  month?: string | null | undefined;
  baselineMonth?: string | null | undefined;
}>;

/**
 * Turns the model's tool input into a request. A value that is not a month
 * is dropped and reported in a note, so the explanation still runs.
 */
export function readExplainInput(input: ExplainInput): {
  request: ExplainRequest;
  ignored: string[];
} {
  const request: { month?: string; baselineMonth?: string } = {};
  const ignored: string[] = [];
  for (const key of ["month", "baselineMonth"] as const) {
    const value = input[key]?.trim();
    if (!value) continue;
    if (MONTH_PATTERN.test(value)) request[key] = value;
    else {
      ignored.push(
        key === "month"
          ? `"${value}" is not a month, so the current month is shown.`
          : `"${value}" is not a month, so it was not used as the baseline.`
      );
    }
  }
  return { request, ignored };
}

export function buildTools(agent: InvoiceBuddyAgent) {
  return {
    getUsageSummary: tool({
      description:
        "Get what the account has used this billing period, per product and metric, against included allowances, and what was billed. Use it for any question about usage or charges.",
      inputSchema: z.object({}),
      execute: async () =>
        describeSummaryForModel(await agent.getUsageSummary())
    }),
    explainBillChange: tool({
      description:
        "Explain the bill for a billing month: the total, the difference from a baseline by product, and any causes found in the account's data. Pass baselineMonth when the owner names a month to compare against. Use it for any question about why a bill is higher, lower or different.",
      // Deliberately loose. The model sometimes fills these with words or
      // amounts from the question ("usual", "$150"); a strict schema made it
      // retry the call until the turn ran out of steps and replied nothing.
      inputSchema: z.object({
        month: z
          .string()
          .nullish()
          .describe("Month to explain, YYYY-MM. Omit for the current month."),
        baselineMonth: z
          .string()
          .nullish()
          .describe(
            "Month to compare against, YYYY-MM. Only if the owner named a month; otherwise omit."
          )
      }),
      execute: async (input) => {
        const { request, ignored } = readExplainInput(input);
        const described = describeForModel(await agent.explainBill(request));
        return ignored.length === 0
          ? described
          : { ...described, notes: [...described.notes, ...ignored] };
      }
    }),
    searchCloudflareDocs: tool({
      description:
        "Search Cloudflare's documentation for how a product is billed or why a charge can change. Use it only after explainBillChange found no cause, or when the owner asks how billing works.",
      inputSchema: z.object({
        query: z.string().describe("What to look up, in a few words.")
      }),
      execute: async ({ query }) => {
        const found = await agent.searchDocs(query);
        if (!found.ok) {
          return {
            results: [],
            note: `Documentation could not be searched: ${found.reason}`
          };
        }
        return {
          results: found.results,
          instruction:
            found.results.length === 0
              ? "Nothing was found. Do not suggest a cause."
              : `A cause taken from these pages is not from the account's data. Start that sentence with "${SPECULATION_LABEL}" and put the page's url in the same sentence. Use only these urls, exactly as given.`
        };
      }
    }),
    getAssistantCost: tool({
      description:
        "Report what this assistant itself has cost to run: metered model usage this month and today, against the daily budget. Use it when the owner asks what the assistant costs.",
      inputSchema: z.object({}),
      execute: async () => agent.getAssistantCost()
    }),
    setDataMode: tool({
      description:
        "Switch between the account's live data and test mode, which uses fixture data. Only call this when the owner asks to switch. The owner must confirm before it runs.",
      inputSchema: z.object({
        dataset: z.enum(["live", "test"]),
        scenario: z.string().optional()
      }),
      needsApproval: true,
      execute: async ({ dataset, scenario }) => {
        if (dataset === "test" && !isScenarioId(scenario)) {
          return { switched: false, chooseOneOf: SCENARIOS };
        }
        return {
          switched: true,
          mode: await agent.setDataMode(dataset, scenario)
        };
      }
    })
  };
}

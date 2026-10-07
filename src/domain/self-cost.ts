/**
 * The assistant's own cost meter (spec UC-8, NFR-O3).
 * Pure code: no Cloudflare imports.
 */
import { ratesFor } from "./models";

/** Published Workers AI rates for the chat model, with where and when they were read. */
export const LLAMA_3_3_PRICE = {
  neuronsPerMillionInputTokens: 26_668,
  neuronsPerMillionOutputTokens: 204_805,
  usdPerThousandNeurons: 0.011,
  freeNeuronsPerDay: 10_000,
  source: "https://developers.cloudflare.com/workers-ai/platform/pricing/",
  checkedOn: "2026-10-04"
} as const;

const TOKENS_PER_MILLION = 1_000_000;
const MICROS_PER_USD = 1_000_000;
const NEURONS_PER_PRICING_UNIT = 1_000;
const BUDGET_WARN_RATIO = 0.8;

export type TokenUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  /** Neuron count returned by Workers AI for the call, when present. */
  reportedNeurons?: number;
}>;

export type MeteredTurn =
  | Readonly<{ metered: false }>
  | Readonly<{
      metered: true;
      inputTokens: number;
      outputTokens: number;
      neurons: number;
      costMicros: number;
    }>;

export type BudgetStatus = "ok" | "warn" | "exhausted";

/**
 * Converts token counts to neurons at the published per-token rates of the
 * model that ran the turn (the chat model unless another is named).
 */
export function toNeurons(
  usage: Pick<TokenUsage, "inputTokens" | "outputTokens">,
  modelId?: string
): number {
  const rates = ratesFor(modelId);
  const inputNeurons =
    (usage.inputTokens * rates.neuronsPerMillionInputTokens) /
    TOKENS_PER_MILLION;
  const outputNeurons =
    (usage.outputTokens * rates.neuronsPerMillionOutputTokens) /
    TOKENS_PER_MILLION;
  return inputNeurons + outputNeurons;
}

/** Prices neurons at list price, in whole micro-dollars, before any free allocation. */
export function toCostMicros(neurons: number): number {
  const usd =
    (neurons / NEURONS_PER_PRICING_UNIT) *
    LLAMA_3_3_PRICE.usdPerThousandNeurons;
  return Math.round(usd * MICROS_PER_USD);
}

/**
 * Builds the meter row for one chat turn. A turn with no usage, or with zero
 * input tokens (what the provider reports when usage is missing), is
 * unmetered: nothing is estimated.
 */
export function meterTurn(
  usage: TokenUsage | undefined,
  modelId?: string
): MeteredTurn {
  if (usage === undefined || usage.inputTokens <= 0) {
    return { metered: false };
  }
  const neurons = usage.reportedNeurons ?? toNeurons(usage, modelId);
  return {
    metered: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    neurons,
    costMicros: toCostMicros(neurons)
  };
}

/** Compares the neurons used in the budget window with the budget. */
export function checkBudget(
  neuronsUsed: number,
  dailyBudgetNeurons: number
): BudgetStatus {
  if (neuronsUsed >= dailyBudgetNeurons) return "exhausted";
  if (neuronsUsed >= dailyBudgetNeurons * BUDGET_WARN_RATIO) return "warn";
  return "ok";
}

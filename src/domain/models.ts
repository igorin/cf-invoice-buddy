/**
 * The Workers AI models the app may call, with their published token rates.
 * Pure code: no Cloudflare imports.
 */

/** The chat model every owner conversation uses. */
export const CHAT_MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/**
 * A much cheaper model, for checks that only prove the pipeline works (the
 * smoke test's one turn). It says nothing about how the chat model behaves.
 */
export const PLUMBING_MODEL_ID = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

export type TokenRates = Readonly<{
  neuronsPerMillionInputTokens: number;
  neuronsPerMillionOutputTokens: number;
  checkedOn: string;
}>;

/** Read from https://developers.cloudflare.com/workers-ai/platform/pricing/. */
export const TOKEN_RATES: Readonly<Record<string, TokenRates>> = {
  [CHAT_MODEL_ID]: {
    neuronsPerMillionInputTokens: 26_668,
    neuronsPerMillionOutputTokens: 204_805,
    checkedOn: "2026-10-04"
  },
  [PLUMBING_MODEL_ID]: {
    neuronsPerMillionInputTokens: 4_119,
    neuronsPerMillionOutputTokens: 34_868,
    checkedOn: "2026-10-06"
  }
};

export const PRICED_MODEL_IDS = [CHAT_MODEL_ID, PLUMBING_MODEL_ID] as const;

/**
 * The rates for a model. A model with no listed rates is metered at the chat
 * model's, the dearest here, so the meter never undercounts.
 */
export function ratesFor(modelId: string | undefined): TokenRates {
  const rates = modelId === undefined ? undefined : TOKEN_RATES[modelId];
  return rates ?? (TOKEN_RATES[CHAT_MODEL_ID] as TokenRates);
}

import { describe, expect, it } from "vitest";
import { readConfig } from "../../src/config";
import {
  CHAT_MODEL_ID,
  PLUMBING_MODEL_ID,
  PRICED_MODEL_IDS,
  TOKEN_RATES,
  ratesFor
} from "../../src/domain/models";
import {
  LLAMA_3_3_PRICE,
  meterTurn,
  toNeurons
} from "../../src/domain/self-cost";
import { chooseModel } from "../../src/model";

const base = {
  CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
  CF_API_TOKEN: "test-token-not-a-real-credential",
  DAILY_NEURON_BUDGET: "500",
  SMOKE_DAILY_NEURON_BUDGET: "3500",
  ENVIRONMENT: "staging",
  ACCESS_TEAM_DOMAIN: "local.cloudflareaccess.com",
  ACCESS_AUD: "0".repeat(64)
};

describe("model rates", () => {
  it("lists rates for every model the app may be configured with", () => {
    for (const id of PRICED_MODEL_IDS) {
      expect(TOKEN_RATES[id]?.neuronsPerMillionInputTokens).toBeGreaterThan(0);
      expect(TOKEN_RATES[id]?.neuronsPerMillionOutputTokens).toBeGreaterThan(0);
    }
  });

  it("keeps the chat model's rates in step with the published price record", () => {
    expect(ratesFor(CHAT_MODEL_ID)).toMatchObject({
      neuronsPerMillionInputTokens:
        LLAMA_3_3_PRICE.neuronsPerMillionInputTokens,
      neuronsPerMillionOutputTokens:
        LLAMA_3_3_PRICE.neuronsPerMillionOutputTokens
    });
  });

  it("meters an unknown or unnamed model at the chat model's rates, never lower", () => {
    expect(ratesFor("@cf/someone/new-model")).toBe(ratesFor(CHAT_MODEL_ID));
    expect(ratesFor(undefined)).toBe(ratesFor(CHAT_MODEL_ID));
  });

  it("meters a turn at the rates of the model that ran it", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(toNeurons(usage)).toBe(26_668 + 204_805);
    expect(toNeurons(usage, PLUMBING_MODEL_ID)).toBe(4_119 + 34_868);
    const turn = meterTurn(usage, PLUMBING_MODEL_ID);
    expect(turn.metered && turn.neurons).toBe(4_119 + 34_868);
  });
});

describe("optional testing settings", () => {
  it("are all unset by default, and an empty value counts as unset", () => {
    const plain = readConfig(base);
    const empty = readConfig({
      ...base,
      SMOKE_MODEL_ID: "",
      AI_GATEWAY_ID: "",
      SMOKE_CACHE_TTL_SECONDS: "",
      RECORD_MODEL_CALLS: ""
    });
    for (const result of [plain, empty]) {
      expect(result.ok && result.config.SMOKE_MODEL_ID).toBeUndefined();
      expect(result.ok && result.config.AI_GATEWAY_ID).toBeUndefined();
      expect(result.ok && result.config.RECORD_MODEL_CALLS).toBeUndefined();
    }
  });

  it("rejects a model with no listed rates, a malformed gateway name and a cache time out of range", () => {
    expect(readConfig({ ...base, SMOKE_MODEL_ID: "@cf/x/unpriced" })).toEqual({
      ok: false,
      invalid: ["SMOKE_MODEL_ID"]
    });
    expect(readConfig({ ...base, AI_GATEWAY_ID: "Not A Name" })).toEqual({
      ok: false,
      invalid: ["AI_GATEWAY_ID"]
    });
    expect(readConfig({ ...base, SMOKE_CACHE_TTL_SECONDS: "5" })).toEqual({
      ok: false,
      invalid: ["SMOKE_CACHE_TTL_SECONDS"]
    });
  });
});

describe("chooseModel", () => {
  const everything = {
    ...base,
    SMOKE_MODEL_ID: PLUMBING_MODEL_ID,
    AI_GATEWAY_ID: "invoice-buddy-smoke",
    SMOKE_CACHE_TTL_SECONDS: "600",
    RECORD_MODEL_CALLS: "1"
  };

  it("gives an owner's instance the chat model, direct, whatever is set", () => {
    expect(chooseModel(everything, false)).toEqual({
      modelId: CHAT_MODEL_ID,
      record: false
    });
  });

  it("changes nothing for the smoke instance when nothing is set", () => {
    expect(chooseModel(base, true)).toEqual({
      modelId: CHAT_MODEL_ID,
      record: false
    });
  });

  it("gives the deployed smoke instance the cheaper model and the cached gateway", () => {
    expect(chooseModel(everything, true)).toEqual({
      modelId: PLUMBING_MODEL_ID,
      gateway: { id: "invoice-buddy-smoke", cacheTtl: 600 },
      record: false
    });
  });

  it("caches for an hour unless told otherwise", () => {
    const choice = chooseModel({ ...base, AI_GATEWAY_ID: "g" }, true);
    expect(choice.gateway).toEqual({ id: "g", cacheTtl: 3_600 });
  });

  it("never caches locally, where evaluations repeat a question on purpose", () => {
    const choice = chooseModel({ ...everything, ENVIRONMENT: "local" }, true);
    expect(choice.gateway).toBeUndefined();
    expect(choice.record).toBe(true);
  });

  it("never records in a deployed environment", () => {
    for (const ENVIRONMENT of ["staging", "production"]) {
      expect(chooseModel({ ...everything, ENVIRONMENT }, true).record).toBe(
        false
      );
    }
  });

  it("falls back to the chat model, direct, when the configuration is invalid", () => {
    expect(chooseModel({ ...everything, CF_API_TOKEN: "" }, true)).toEqual({
      modelId: CHAT_MODEL_ID,
      record: false
    });
  });
});

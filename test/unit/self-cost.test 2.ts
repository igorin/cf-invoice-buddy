import { describe, expect, it } from "vitest";
import {
  LLAMA_3_3_PRICE,
  checkBudget,
  meterTurn,
  toCostMicros,
  toNeurons
} from "../../src/domain/self-cost";

describe("toNeurons (UC-8)", () => {
  it("matches the neuron count Cloudflare reported for a real call", () => {
    // Observed on the account on 2026-10-05: 343 input and 31 output tokens
    // were reported as 15.495975732803345 neurons.
    expect(toNeurons({ inputTokens: 343, outputTokens: 31 })).toBeCloseTo(
      15.496,
      3
    );
  });

  it("returns zero for zero tokens", () => {
    expect(toNeurons({ inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe("toCostMicros (UC-8)", () => {
  it("prices one million neurons at the published rate", () => {
    expect(toCostMicros(1_000_000)).toBe(11_000_000);
  });

  it("rounds to whole micro-dollars", () => {
    expect(Number.isInteger(toCostMicros(15.495975732803345))).toBe(true);
    expect(toCostMicros(15.495975732803345)).toBe(170);
  });
});

describe("meterTurn (UC-8)", () => {
  it("meters a turn from its token counts", () => {
    const row = meterTurn({ inputTokens: 343, outputTokens: 31 });
    expect(row).toEqual({
      metered: true,
      inputTokens: 343,
      outputTokens: 31,
      neurons: toNeurons({ inputTokens: 343, outputTokens: 31 }),
      costMicros: 170
    });
  });

  it("prefers the neuron count reported by Workers AI", () => {
    const row = meterTurn({
      inputTokens: 343,
      outputTokens: 31,
      reportedNeurons: 16
    });
    expect(row.metered && row.neurons).toBe(16);
  });

  it("marks a turn unmetered when usage is missing", () => {
    expect(meterTurn(undefined)).toEqual({ metered: false });
  });

  it("marks a turn unmetered when input tokens are zero, the provider's stand-in for missing usage", () => {
    expect(meterTurn({ inputTokens: 0, outputTokens: 0 })).toEqual({
      metered: false
    });
  });
});

describe("checkBudget (NFR-O3)", () => {
  it("is ok below 80% of the budget", () => {
    expect(checkBudget(7_999, 10_000)).toBe("ok");
  });

  it("warns from 80% of the budget", () => {
    expect(checkBudget(8_000, 10_000)).toBe("warn");
  });

  it("is exhausted at 100% of the budget", () => {
    expect(checkBudget(10_000, 10_000)).toBe("exhausted");
  });

  it("is exhausted when the budget is zero", () => {
    expect(checkBudget(0, 0)).toBe("exhausted");
  });
});

describe("price constants (UC-8)", () => {
  it("carry a source and a check date no older than 90 days", () => {
    const ageMs = Date.now() - Date.parse(LLAMA_3_3_PRICE.checkedOn);
    expect(LLAMA_3_3_PRICE.source).toMatch(
      /^https:\/\/developers\.cloudflare\.com\//
    );
    expect(ageMs).toBeLessThan(90 * 24 * 60 * 60 * 1000);
  });
});

import { describe, expect, it } from "vitest";
import type { ExplanationView } from "../../src/services/explain-service";
import { describeForModel } from "../../src/tools/explain-tool";

const view = (outcome: ExplanationView["outcome"]): ExplanationView =>
  ({
    period: { start: "2026-10-01", end: "2026-11-01" },
    partial: true,
    outcome,
    total: "$0.00",
    baseline: null,
    services: [],
    daily: [],
    findings: [],
    unexplained: null,
    notes: [],
    dataset: "test",
    scenario: "zero-bill",
    assistantOwnUsage: null
  }) as unknown as ExplanationView;

describe("the bill explanation's instruction to the model", () => {
  it("tells the model to give no link when there are no charges", () => {
    // In the third release evaluation the model made up a documentation
    // link in exactly this case.
    expect(describeForModel(view("no_charges")).instruction).toBe(
      "Say there are no charges to explain, and that the usage summary shows what was used. Give no link."
    );
  });

  it("has an instruction for every outcome", () => {
    for (const outcome of [
      "explained",
      "none_found",
      "no_baseline",
      "no_charges"
    ] as const) {
      expect(
        describeForModel(view(outcome)).instruction.length
      ).toBeGreaterThan(20);
    }
  });
});

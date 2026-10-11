import { describe, expect, it } from "vitest";
import { explainBill } from "../../src/domain/explain";
import { fromUsd } from "../../src/domain/money";
import { isoDate, type BillingPeriod } from "../../src/domain/periods";
import type { UsageRecord } from "../../src/domain/usage";

const period = (start: string, end: string): BillingPeriod => ({
  start: isoDate(start),
  end: isoDate(end)
});

/** A month of Workers usage at a flat $4.00 a day. */
const month = (start: string, days: number): UsageRecord[] =>
  Array.from({ length: days }, (_, index) => {
    const day = new Date(`${start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return {
      date: isoDate(day.toISOString().slice(0, 10)),
      service: "Workers",
      metric: "requests",
      zone: null,
      quantity: 4_000_000,
      unit: "requests",
      billableQuantity: null,
      costMicros: fromUsd(4)
    };
  });

describe("the unexplained remainder and a period of a different length", () => {
  it("does not list as unexplained a difference the period's length accounts for", () => {
    // 30 days against two baseline months of 31, at the same daily cost.
    const explanation = explainBill({
      period: period("2026-09-01", "2026-10-01"),
      today: isoDate("2026-10-01"),
      current: month("2026-09-01", 30),
      baseline: {
        chosenByOwner: false,
        periods: [
          {
            period: period("2026-08-01", "2026-09-01"),
            records: month("2026-08-01", 31)
          },
          {
            period: period("2026-07-01", "2026-08-01"),
            records: month("2026-07-01", 31)
          }
        ]
      },
      invoiceMicros: null,
      billing: { status: "costed" }
    });
    expect(explanation.total).toBe("$120.00");
    expect(explanation.findings.map((finding) => finding.statement)).toEqual([
      expect.stringContaining("30 days against a usual 31")
    ]);
    expect(explanation.unexplained).toBe("$0.00");
  });
});

import { describe, expect, it } from "vitest";
import {
  ALLOWANCES,
  ALLOWANCE_SOURCE,
  findAllowance
} from "../../src/domain/allowances";
import { fromUsd } from "../../src/domain/money";
import { isoDate } from "../../src/domain/periods";
import { buildUsageSummary } from "../../src/domain/usage-summary";
import type { UsageRecord } from "../../src/domain/usage";
import { month } from "../fixtures/usage";

const OCT = month("2026-10");
const TODAY = isoDate("2026-10-05");

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    date: TODAY,
    service: "Workers AI",
    metric: "neurons",
    zone: null,
    quantity: 311,
    unit: "neurons",
    billableQuantity: null,
    costMicros: null,
    ...overrides
  };
}

const base = {
  period: OCT,
  today: TODAY,
  plan: "free" as const,
  sources: [],
  billing: { status: "none" as const }
};

describe("allowances", () => {
  it("finds the free-plan allowance for Workers AI neurons", () => {
    expect(findAllowance("free", "Workers AI", "neurons")).toMatchObject({
      amount: 10_000,
      per: "day"
    });
  });

  it("returns nothing for a metric that is not in the table", () => {
    expect(findAllowance("free", "Stream", "minutes")).toBeUndefined();
  });

  it("carries a source and a check date no older than 90 days", () => {
    const age = Date.now() - Date.parse(ALLOWANCE_SOURCE.checkedOn);
    expect(age).toBeLessThan(90 * 24 * 60 * 60 * 1000);
    expect(
      ALLOWANCE_SOURCE.urls.every((url) =>
        url.startsWith("https://developers.cloudflare.com/")
      )
    ).toBe(true);
    expect(ALLOWANCES.every((a) => a.amount > 0)).toBe(true);
  });
});

describe("buildUsageSummary (UC-9)", () => {
  it("shows real usage on a $0 account with no invoice", () => {
    const summary = buildUsageSummary({
      ...base,
      records: [
        record({ date: isoDate("2026-10-04"), quantity: 100 }),
        record({ quantity: 311 })
      ]
    });
    expect(summary.rows).toEqual([
      {
        service: "Workers AI",
        metric: "neurons",
        unit: "neurons",
        quantity: 411,
        today: 311,
        allowance: { amount: 10_000, per: "day", used: 311, share: 0.0311 },
        billed: { status: "none" }
      }
    ]);
    expect(summary.billing).toEqual({ status: "none" });
  });

  it("measures a monthly allowance against the whole period", () => {
    const summary = buildUsageSummary({
      ...base,
      plan: "paid",
      records: [
        record({
          service: "Workers",
          metric: "requests",
          unit: "requests",
          quantity: 4_000_000,
          date: isoDate("2026-10-02")
        }),
        record({
          service: "Workers",
          metric: "requests",
          unit: "requests",
          quantity: 1_000_000
        })
      ]
    });
    expect(summary.rows[0]?.allowance).toEqual({
      amount: 10_000_000,
      per: "month",
      used: 5_000_000,
      share: 0.5
    });
  });

  it("omits the allowance when the table has none, and does not guess one", () => {
    const summary = buildUsageSummary({
      ...base,
      records: [
        record({ service: "Stream", metric: "minutes", unit: "minutes" })
      ]
    });
    expect(summary.rows[0]?.allowance).toBeNull();
  });

  it("lists a product whose source failed as unavailable, never as zero", () => {
    const summary = buildUsageSummary({
      ...base,
      records: [record({})],
      sources: [
        { service: "Workers AI", available: true },
        { service: "Workflows", available: false, reason: "HTTP 503" }
      ]
    });
    expect(summary.unavailable).toEqual([
      { service: "Workflows", reason: "HTTP 503" }
    ]);
    expect(summary.rows.map((row) => row.service)).toEqual(["Workers AI"]);
  });

  it("drops rows for a product whose source failed, even if old rows exist", () => {
    const summary = buildUsageSummary({
      ...base,
      records: [
        record({
          service: "Workflows",
          metric: "steps",
          unit: "steps",
          quantity: 0
        })
      ],
      sources: [{ service: "Workflows", available: false, reason: "timeout" }]
    });
    expect(summary.rows).toEqual([]);
  });

  it("shows the billed amount when the billing source has costs", () => {
    const summary = buildUsageSummary({
      ...base,
      billing: { status: "costed" },
      records: [
        record({ costMicros: fromUsd(1.25) }),
        record({ date: isoDate("2026-10-04"), costMicros: fromUsd(0.75) })
      ]
    });
    expect(summary.rows[0]?.billed).toEqual({
      status: "amount",
      micros: fromUsd(2),
      text: "$2.00"
    });
  });

  it("marks the amount unavailable when any record of the row has no cost", () => {
    const summary = buildUsageSummary({
      ...base,
      billing: { status: "costed" },
      records: [
        record({ costMicros: fromUsd(1) }),
        record({ date: isoDate("2026-10-04"), costMicros: null })
      ]
    });
    expect(summary.rows[0]?.billed).toEqual({ status: "unavailable" });
  });

  it("marks every amount unavailable when billing could not be read", () => {
    const summary = buildUsageSummary({
      ...base,
      billing: { status: "unavailable", reason: "HTTP 403" },
      records: [record({ costMicros: fromUsd(1) })]
    });
    expect(summary.rows[0]?.billed).toEqual({ status: "unavailable" });
  });

  it("ignores records outside the period and orders rows by product and metric", () => {
    const summary = buildUsageSummary({
      ...base,
      records: [
        record({ service: "Workers", metric: "requests", unit: "requests" }),
        record({
          service: "Durable Objects",
          metric: "rows written",
          unit: "rows"
        }),
        record({
          service: "Durable Objects",
          metric: "requests",
          unit: "requests"
        }),
        record({
          date: isoDate("2026-09-30"),
          service: "R2",
          metric: "storage",
          unit: "GB"
        })
      ]
    });
    expect(summary.rows.map((row) => `${row.service}/${row.metric}`)).toEqual([
      "Durable Objects/requests",
      "Durable Objects/rows written",
      "Workers/requests"
    ]);
  });

  it("returns no rows for no records", () => {
    expect(buildUsageSummary({ ...base, records: [] }).rows).toEqual([]);
  });
});

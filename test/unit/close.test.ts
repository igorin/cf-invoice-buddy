import { describe, expect, it } from "vitest";
import {
  CLOSE_STATES,
  checkCloseStart,
  describeCloseState,
  isInProgress,
  summariseClose,
  type CloseInput
} from "../../src/domain/close";
import { fromUsd } from "../../src/domain/money";
import { isoDate, type BillingPeriod } from "../../src/domain/periods";
import type { UsageRecord } from "../../src/domain/usage";

const period = (start: string, end: string): BillingPeriod => ({
  start: isoDate(start),
  end: isoDate(end)
});
const SEPTEMBER = period("2026-09-01", "2026-10-01");

const record = (date: string, service: string, usd: number): UsageRecord => ({
  date: isoDate(date),
  service,
  metric: "requests",
  zone: null,
  quantity: usd * 1_000_000,
  unit: "requests",
  billableQuantity: null,
  costMicros: fromUsd(usd)
});

/** A month of one product at a flat daily cost, with optional other days. */
const month = (
  start: string,
  days: number,
  service: string,
  usdPerDay: number,
  overrides: Record<number, number> = {}
): UsageRecord[] =>
  Array.from({ length: days }, (_, index) => {
    const day = new Date(`${start}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return record(
      day.toISOString().slice(0, 10),
      service,
      overrides[index] ?? usdPerDay
    );
  });

const baseline: CloseInput["baseline"] = {
  chosenByOwner: false,
  periods: [
    {
      period: period("2026-08-01", "2026-09-01"),
      records: month("2026-08-01", 31, "Workers", 4)
    },
    {
      period: period("2026-07-01", "2026-08-01"),
      records: month("2026-07-01", 31, "Workers", 4)
    }
  ]
};

const input = (overrides: Partial<CloseInput> = {}): CloseInput => ({
  period: SEPTEMBER,
  snapshot: [
    ...month("2026-09-01", 30, "Workers", 4, { 1: 90, 2: 110 }),
    ...month("2026-09-01", 30, "R2", 1)
  ],
  baseline,
  invoiceMicros: null,
  billing: { status: "costed" },
  ...overrides
});

describe("checkCloseStart (UC-6)", () => {
  const today = isoDate("2026-10-07");

  it("allows a finished period that has no close", () => {
    expect(checkCloseStart(SEPTEMBER, today, null)).toBe("ok");
  });

  it("refuses a period that has not ended", () => {
    expect(
      checkCloseStart(period("2026-10-01", "2026-11-01"), today, null)
    ).toBe("open_period");
    expect(checkCloseStart(SEPTEMBER, isoDate("2026-09-30"), null)).toBe(
      "open_period"
    );
    expect(checkCloseStart(SEPTEMBER, isoDate("2026-10-01"), null)).toBe("ok");
  });

  it("closes a period once only", () => {
    expect(checkCloseStart(SEPTEMBER, today, "closed")).toBe("already_closed");
  });

  it("allows one close at a time for a period", () => {
    expect(checkCloseStart(SEPTEMBER, today, "snapshotted")).toBe(
      "in_progress"
    );
    expect(checkCloseStart(SEPTEMBER, today, "awaiting_approval")).toBe(
      "in_progress"
    );
  });

  it.each(["rejected", "expired", "failed"] as const)(
    "lets a %s close be started again, since the period is still open",
    (state) => {
      expect(checkCloseStart(SEPTEMBER, today, state)).toBe("ok");
    }
  );
});

describe("summariseClose (UC-6)", () => {
  it("totals the snapshot into one line per product", () => {
    const summary = summariseClose(input());
    expect(summary.month).toBe("2026-09");
    expect(summary.total).toBe("$342.00");
    expect(summary.lineItems).toEqual(
      expect.arrayContaining([
        { service: "Workers", amount: "$312.00" },
        { service: "R2", amount: "$30.00" }
      ])
    );
    expect(summary.usageRecords).toBe(60);
  });

  it("runs the detectors on the snapshot and reports what they find", () => {
    const summary = summariseClose(input());
    expect(summary.findings.some((f) => f.service === "Workers")).toBe(true);
    expect(JSON.stringify(summary.findings)).toContain("2026-09-02");
  });

  it("treats the period as finished whatever the date", () => {
    expect(summariseClose(input()).notes.join(" ")).not.toContain("still open");
  });

  it("says the total could not be reconciled when there is no invoice", () => {
    expect(summariseClose(input()).reconciliation).toEqual({
      status: "no_invoice",
      invoice: null,
      statement:
        "There is no invoice for this period in the account's data, so the usage total could not be reconciled."
    });
  });

  it("reports an invoice that matches the usage total", () => {
    const summary = summariseClose(input({ invoiceMicros: fromUsd(342) }));
    expect(summary.reconciliation).toEqual({
      status: "matched",
      invoice: "$342.00",
      statement: "The invoice ($342.00) matches the usage total ($342.00)."
    });
  });

  it("flags a gap between the invoice and the usage total, in either direction", () => {
    expect(
      summariseClose(input({ invoiceMicros: fromUsd(400) })).reconciliation
    ).toEqual({
      status: "variance",
      invoice: "$400.00",
      statement:
        "The invoice ($400.00) is $58.00 more than the usage total ($342.00)."
    });
    expect(
      summariseClose(input({ invoiceMicros: fromUsd(300) })).reconciliation
        .statement
    ).toBe(
      "The invoice ($300.00) is $42.00 less than the usage total ($342.00)."
    );
  });

  it("copes with a period that had no usage", () => {
    const summary = summariseClose(
      input({ snapshot: [], billing: { status: "none" } })
    );
    expect(summary.lineItems).toEqual([]);
    expect(summary.usageRecords).toBe(0);
  });
});

describe("close states", () => {
  it("describes every state and says when the period is still open", () => {
    for (const state of CLOSE_STATES) {
      expect(describeCloseState(state).length).toBeGreaterThan(0);
    }
    for (const state of [
      "awaiting_approval",
      "rejected",
      "expired",
      "failed"
    ] as const) {
      expect(describeCloseState(state)).toContain("still open");
    }
    expect(describeCloseState("closed")).toContain("final");
  });

  it("counts only a running close as in progress", () => {
    expect(CLOSE_STATES.filter(isInProgress)).toEqual([
      "snapshotted",
      "awaiting_approval"
    ]);
  });
});

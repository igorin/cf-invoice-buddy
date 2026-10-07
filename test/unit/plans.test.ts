import { describe, expect, it } from "vitest";
import { ALLOWANCES } from "../../src/domain/allowances";
import { isoDate, type BillingPeriod } from "../../src/domain/periods";
import {
  NOT_MEASURED,
  PRICE_TABLE,
  comparePlans,
  type PlanInput
} from "../../src/domain/plans";
import type { UsageRecord } from "../../src/domain/usage";

const SEPTEMBER: BillingPeriod = {
  start: isoDate("2026-09-01"),
  end: isoDate("2026-10-01")
};

const record = (
  day: number,
  service: string,
  metric: string,
  quantity: number
): UsageRecord => ({
  date: isoDate(`2026-09-${String(day).padStart(2, "0")}`),
  service,
  metric,
  zone: null,
  quantity,
  unit: metric,
  billableQuantity: null,
  costMicros: null
});

const everyDay = (service: string, metric: string, quantity: number) =>
  Array.from({ length: 30 }, (_, index) =>
    record(index + 1, service, metric, quantity)
  );

const compare = (records: UsageRecord[], overrides: Partial<PlanInput> = {}) =>
  comparePlans({
    period: SEPTEMBER,
    today: isoDate("2026-10-07"),
    records,
    currentPlan: "free",
    ...overrides
  });

const paidOf = (records: UsageRecord[]) => {
  const paid = compare(records).plans.find((plan) => plan.plan === "paid");
  if (!paid) throw new Error("no paid estimate");
  return paid;
};

describe("price table (UC-7)", () => {
  it("has an included amount for every rate, on both plans", () => {
    for (const rate of PRICE_TABLE.rates) {
      for (const plan of ["free", "paid"] as const) {
        expect(
          ALLOWANCES.some(
            (allowance) =>
              allowance.plan === plan &&
              allowance.service === rate.service &&
              allowance.metric === rate.metric
          ),
          `${plan} ${rate.service} ${rate.metric}`
        ).toBe(true);
      }
    }
  });

  it("was read from Cloudflare's pricing pages within the last 90 days", () => {
    const ageMs = Date.now() - Date.parse(PRICE_TABLE.checkedOn);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(90 * 24 * 3_600_000);
    for (const url of PRICE_TABLE.urls) {
      expect(url).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
    }
  });
});

describe("comparePlans (UC-7)", () => {
  it("says usage inside the free limits costs nothing on Free and the monthly price on Paid", () => {
    const result = compare(everyDay("Workers", "requests", 50_000));
    expect(result.fitsFree).toBe(true);
    expect(result.plans.map((plan) => [plan.plan, plan.total])).toEqual([
      ["free", "$0.00"],
      ["paid", "$5.00"]
    ]);
    expect(result.verdict).toBe(
      "This period's usage fits inside the daily limits of Workers Free, which costs $0.00. On Workers Paid the same usage is estimated at $5.00, of which $5.00 is the plan's monthly price."
    );
  });

  it("prices usage beyond the paid plan's monthly allowance at the listed rate", () => {
    // 30 days x 4,000,000 = 120,000,000 requests; 110,000,000 beyond 10 million.
    const paid = paidOf(everyDay("Workers", "requests", 4_000_000));
    expect(paid.lines).toEqual([
      {
        service: "Workers",
        metric: "requests",
        used: "120,000,000 requests",
        included: "10,000,000 requests a month",
        billable: "110,000,000 requests",
        rate: "$0.30 per 1,000,000 requests",
        cost: "$33.00"
      }
    ]);
    expect(paid.total).toBe("$38.00");
    expect(paid.base).toBe("$5.00");
  });

  it("counts a daily allowance day by day, not across the month", () => {
    // One day of 30,000 neurons: 20,000 beyond that day's 10,000.
    const paid = paidOf([
      record(1, "Workers AI", "neurons", 30_000),
      record(2, "Workers AI", "neurons", 2_000)
    ]);
    expect(paid.lines[0]).toMatchObject({
      used: "32,000 neurons",
      included: "10,000 neurons a day",
      billable: "20,000 neurons",
      cost: "$0.22"
    });
    expect(paid.total).toBe("$5.22");
  });

  it("adds up several products", () => {
    const paid = paidOf([
      ...everyDay("Workers", "requests", 1_000_000),
      ...everyDay("Durable Objects", "requests", 100_000),
      ...everyDay("Workflows", "steps", 20_000)
    ]);
    // Workers: 20M over x $0.30 = $6.00. DO: 2M over x $0.15 = $0.30.
    // Workflows: 100,000 over x $0.80 per 100,000 = $0.80.
    expect(paid.lines.map((line) => line.cost)).toEqual([
      "$6.00",
      "$0.30",
      "$0.80"
    ]);
    expect(paid.total).toBe("$12.10");
  });

  it("names the free limits the usage went over, and says such usage fails and is not billed", () => {
    const result = compare([
      ...everyDay("Workers", "requests", 4_000_000),
      record(3, "Workers AI", "neurons", 12_000)
    ]);
    expect(result.fitsFree).toBe(false);
    const free = result.plans[0];
    expect(free?.total).toBe("$0.00");
    expect(free?.overLimit).toEqual([
      {
        service: "Workers",
        metric: "requests",
        limit: "100,000 requests a day",
        daysOver: 30
      },
      {
        service: "Workers AI",
        metric: "neurons",
        limit: "10,000 neurons a day",
        daysOver: 1
      }
    ]);
    expect(result.verdict).toBe(
      "This period's usage went over the daily limits of Workers Free: Workers requests passed 100,000 requests a day on 30 days, and 1 other limit was passed too. On Workers Free, usage beyond a limit fails; it is not billed. On Workers Paid the same usage is estimated at $38.02, of which $5.00 is the plan's monthly price."
    );
  });

  it("uses the singular for one day over one limit", () => {
    expect(
      compare([record(3, "Workers AI", "neurons", 12_000)]).verdict
    ).toContain(
      "Workers AI neurons passed 10,000 neurons a day on 1 day. On Workers Free"
    );
  });

  it("leaves usage with no rate out of the totals and says so", () => {
    const result = compare([
      ...everyDay("Workers", "requests", 50_000),
      ...everyDay("R2", "storage", 66)
    ]);
    expect(result.notPriced).toEqual([{ service: "R2", metric: "storage" }]);
    expect(result.plans[1]?.total).toBe("$5.00");
  });

  it("is always labelled an estimate, with its source and what it cannot see", () => {
    const result = compare(everyDay("Workers", "requests", 50_000));
    expect(result.estimate).toBe(true);
    expect(result.notes[0]).toContain("estimates at list price");
    expect(result.notMeasured).toEqual(NOT_MEASURED);
    expect(result.priceSource).toEqual({
      checkedOn: PRICE_TABLE.checkedOn,
      urls: PRICE_TABLE.urls
    });
    expect(result.currentPlan).toBe("free");
    expect(result.month).toBe("2026-09");
  });

  it("says when the period is still open", () => {
    const open = compare(everyDay("Workers", "requests", 50_000), {
      today: isoDate("2026-09-10")
    });
    expect(open.partial).toBe(true);
    expect(open.notes.join(" ")).toContain(
      "This period is still open: the usage covers part of its 30 days"
    );
    expect(compare([]).partial).toBe(false);
  });

  it("copes with a period that has no usage", () => {
    const result = compare([]);
    expect(result.fitsFree).toBe(true);
    expect(result.plans[1]?.lines).toEqual([]);
    expect(result.notes).toContain(
      "There is no usage in this period to compare."
    );
  });
});

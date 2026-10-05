import { describe, expect, it } from "vitest";
import { explainBill, type ExplainInput } from "../../src/domain/explain";
import { fromUsd } from "../../src/domain/money";
import {
  isInPeriod,
  isoDate,
  periodContaining,
  precedingPeriods,
  type IsoDate
} from "../../src/domain/periods";
import { buildScenario, type ScenarioId } from "../../src/domain/scenarios";

/** Builds the explain input for a scenario, with up to `baselines` earlier months. */
function inputFor(
  id: ScenarioId,
  todayText: string,
  baselines = 3
): ExplainInput {
  const today = isoDate(todayText);
  const data = buildScenario(id, today);
  const period = periodContaining(today, data.anchorDay);
  const within = (p: typeof period) =>
    data.records.filter((r) => isInPeriod(r.date, p));
  return {
    period,
    today,
    current: within(period),
    baseline: {
      chosenByOwner: false,
      periods: precedingPeriods(period, data.anchorDay, baselines).map((p) => ({
        period: p,
        records: within(p)
      }))
    },
    invoiceMicros: null,
    billing: data.billing
  };
}

describe("explainBill on a closed-out month (UC-1)", () => {
  const result = explainBill(inputFor("usage-spike", "2026-10-31"));

  it("reports the total, the baseline and the difference as text", () => {
    expect(result.outcome).toBe("explained");
    expect(result.total).toBe("$347.00");
    expect(result.baseline).toEqual({
      months: ["2026-09", "2026-08", "2026-07"],
      total: "$153.33",
      difference: "$193.67",
      direction: "higher",
      percent: "126.3%"
    });
  });

  it("lists services with the largest change first", () => {
    expect(result.services[0]).toEqual({
      service: "Workers",
      current: "$316.00",
      usual: "$122.67",
      difference: "$193.33",
      direction: "higher"
    });
  });

  it("carries each finding with its statement, impact and evidence (G-5)", () => {
    expect(result.findings[0]).toMatchObject({
      impact: "$192.00",
      evidence: [
        { date: "2026-10-01", cost: "$90.00" },
        { date: "2026-10-02", cost: "$110.00" }
      ]
    });
    expect(result.findings[0]?.statement).toContain(
      "Workers cost $200.00 over 2 days"
    );
  });

  it("gives the daily costs of the biggest movers", () => {
    expect(result.daily[0]?.service).toBe("Workers");
    expect(result.daily[0]?.days[0]).toEqual({
      date: "2026-10-01",
      cost: "$90.00"
    });
    expect(result.daily.length).toBeLessThanOrEqual(3);
  });

  it("states what the findings leave unexplained", () => {
    expect(result.unexplained).toBe("$1.67");
  });
});

describe("explainBill with nothing to find (UC-2, G-4)", () => {
  it("returns none_found, with the breakdown and the unexplained amount", () => {
    const result = explainBill(inputFor("lower-no-cause", "2026-10-31"));
    expect(result.outcome).toBe("none_found");
    expect(result.findings).toEqual([]);
    expect(result.baseline?.direction).toBe("lower");
    expect(result.unexplained).toBe("-$13.83");
    expect(result.services.length).toBeGreaterThan(0);
  });
});

describe("explainBill part-way through a period (G-6)", () => {
  const result = explainBill(inputFor("lower-no-cause", "2026-10-10"));

  it("compares like with like: the same number of days of each baseline month", () => {
    expect(result.partial).toBe(true);
    expect(result.total).toBe("$45.00");
    expect(result.baseline?.total).toBe("$50.00");
  });

  it("says the period is open and how the comparison was made", () => {
    expect(result.notes).toContain(
      "This period is still open. Figures cover its first 10 days and are compared with the first 10 days of each baseline month."
    );
  });
});

describe("explainBill baselines", () => {
  it("has no baseline when no earlier month is stored, and invents none", () => {
    const result = explainBill(inputFor("usage-spike", "2026-10-31", 0));
    expect(result.outcome).toBe("no_baseline");
    expect(result.baseline).toBeNull();
    expect(result.unexplained).toBeNull();
    expect(result.services[0]).toEqual({
      service: "Workers",
      current: "$316.00",
      usual: null,
      difference: null,
      direction: null
    });
    expect(result.notes).toContain(
      "There is no earlier month to compare with. Name a month to compare against."
    );
  });

  it("does not compare against a single month it picked for itself", () => {
    const result = explainBill(inputFor("usage-spike", "2026-10-31", 1));
    expect(result.outcome).toBe("no_baseline");
  });

  it("compares against a single month when the owner chose it", () => {
    const input = inputFor("usage-spike", "2026-10-31", 1);
    const result = explainBill({
      ...input,
      baseline: { ...input.baseline, chosenByOwner: true }
    });
    expect(result.outcome).toBe("explained");
    expect(result.baseline?.months).toEqual(["2026-09"]);
    expect(result.baseline?.total).toBe("$150.00");
  });
});

describe("explainBill on an account with no charges (UC-9)", () => {
  it("says there is no charge to explain", () => {
    const result = explainBill(inputFor("zero-bill", "2026-10-31"));
    expect(result.outcome).toBe("no_charges");
    expect(result.total).toBe("$0.00");
    expect(result.findings).toEqual([]);
    expect(result.baseline).toBeNull();
  });
});

describe("explainBill with an invoice", () => {
  it("flags an invoice that differs from the usage, even without a baseline", () => {
    const input = inputFor("usage-spike", "2026-10-31", 0);
    const result = explainBill({ ...input, invoiceMicros: fromUsd(400) });
    expect(result.findings[0]?.statement).toContain("The invoice is $400.00");
  });
});

describe("explainBill data gaps (G-6)", () => {
  it("notes records the source gave no cost for", () => {
    const input = inputFor("usage-spike", "2026-10-31");
    const [first, ...rest] = input.current;
    const result = explainBill({
      ...input,
      current: [{ ...first!, costMicros: null }, ...rest]
    });
    expect(result.notes).toContain(
      "1 usage record has no cost from the billing source and is left out of the amounts."
    );
  });

  it("notes when billed amounts could not be read at all", () => {
    const input = inputFor("usage-spike", "2026-10-31");
    const result = explainBill({
      ...input,
      billing: { status: "unavailable", reason: "HTTP 403" }
    });
    expect(result.notes).toContain(
      "Billed amounts could not be read: HTTP 403"
    );
  });
});

describe("explainBill limits its size for the model's context", () => {
  it("returns at most 8 services and 3 daily series", () => {
    const input = inputFor("usage-spike", "2026-10-31");
    const extra = Array.from({ length: 12 }, (_, i) => ({
      ...input.current[0]!,
      service: `Service ${i}`,
      date: "2026-10-03" as IsoDate
    }));
    const result = explainBill({
      ...input,
      current: [...input.current, ...extra]
    });
    expect(result.services).toHaveLength(8);
    expect(result.daily).toHaveLength(3);
  });
});

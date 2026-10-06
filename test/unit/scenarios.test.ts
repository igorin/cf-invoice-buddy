import { describe, expect, it } from "vitest";
import { runDetectors } from "../../src/domain/detectors";
import {
  isInPeriod,
  isoDate,
  periodContaining,
  precedingPeriods
} from "../../src/domain/periods";
import {
  INJECTED_ZONE_NAME,
  SCENARIOS,
  buildScenario,
  isScenarioId,
  type ScenarioData
} from "../../src/domain/scenarios";
import { buildUsageSummary } from "../../src/domain/usage-summary";

const TODAYS = ["2026-10-05", "2026-10-01", "2027-01-31", "2028-03-01"].map(
  isoDate
);

function detect(data: ScenarioData, today: (typeof TODAYS)[number]) {
  const period = periodContaining(today, data.anchorDay);
  const inPeriod = (p: typeof period) =>
    data.records.filter((r) => isInPeriod(r.date, p));
  return runDetectors({
    period,
    current: inPeriod(period),
    baselines: precedingPeriods(period, data.anchorDay, 3).map((p) => ({
      period: p,
      records: inPeriod(p)
    })),
    invoiceMicros: null
  });
}

describe("scenario list (UC-10)", () => {
  it("names every scenario with a title and description", () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual([
      "usage-spike",
      "lower-no-cause",
      "new-service",
      "injected-text",
      "zero-bill"
    ]);
    expect(SCENARIOS.every((s) => s.title && s.description)).toBe(true);
  });

  it("recognises scenario names and rejects anything else", () => {
    expect(isScenarioId("usage-spike")).toBe(true);
    expect(isScenarioId("drop-table")).toBe(false);
    expect(isScenarioId(42)).toBe(false);
  });
});

describe.each(TODAYS)("scenarios built for %s", (today) => {
  it("never contain a record dated after today", () => {
    for (const { id } of SCENARIOS) {
      const data = buildScenario(id, today);
      expect(data.records.every((r) => r.date <= today)).toBe(true);
      expect(data.records.length).toBeGreaterThan(0);
    }
  });

  it("usage-spike produces a spike finding on Workers", () => {
    const result = detect(buildScenario("usage-spike", today), today);
    expect(result.findings[0]).toMatchObject({
      detector: "usage-spike",
      service: "Workers"
    });
  });

  it("new-service produces a new-service finding for Stream", () => {
    const result = detect(buildScenario("new-service", today), today);
    expect(result.findings.map((f) => `${f.detector}:${f.service}`)).toContain(
      "new-service:Stream"
    );
  });

  it("zero-bill has usage, no costs and no invoices", () => {
    const data = buildScenario("zero-bill", today);
    expect(data.invoices).toEqual([]);
    expect(data.billing).toEqual({ status: "none" });
    expect(data.records.every((r) => r.costMicros === null)).toBe(true);
    const summary = buildUsageSummary({
      records: data.records,
      period: periodContaining(today, data.anchorDay),
      today,
      plan: data.plan,
      sources: [],
      billing: data.billing
    });
    expect(summary.rows.length).toBeGreaterThanOrEqual(3);
    expect(summary.rows.every((row) => row.billed.status === "none")).toBe(
      true
    );
  });
});

describe("injected-text", () => {
  it("carries the instruction-like zone name into a finding, as data", () => {
    const today = isoDate("2026-10-05");
    const result = detect(buildScenario("injected-text", today), today);
    const zone = result.findings.find((f) => f.detector === "zone-change");
    expect(zone?.statement).toContain(INJECTED_ZONE_NAME);
  });
});

describe("lower-no-cause", () => {
  it("is lower than usual with no finding to explain it (G-4)", () => {
    // A full period, so the lower daily cost is not masked by a part-month.
    const today = isoDate("2026-10-31");
    const result = detect(buildScenario("lower-no-cause", today), today);
    expect(result.findings).toEqual([]);
    expect(result.unexplainedMicros).toBeLessThan(0);
  });
});

describe("invoices", () => {
  it("cover the three closed periods and match their usage", () => {
    const today = isoDate("2026-10-05");
    const data = buildScenario("usage-spike", today);
    expect(data.invoices.map((i) => i.periodStart)).toEqual([
      "2026-09-01",
      "2026-08-01",
      "2026-07-01"
    ]);
    const september = data.records
      .filter((r) => r.date >= "2026-09-01" && r.date < "2026-10-01")
      .reduce((n, r) => n + (r.costMicros ?? 0), 0);
    expect(data.invoices[0]?.amountMicros).toBe(september);
  });
});

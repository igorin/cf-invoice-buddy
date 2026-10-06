import { describe, expect, it } from "vitest";
import { runDetectors, type DetectorInput } from "../../src/domain/detectors";
import { fromUsd } from "../../src/domain/money";
import { reconcile } from "../../src/domain/reconcile";
import type { UsageRecord } from "../../src/domain/usage";
import { daily, month } from "../fixtures/usage";

const JUL = month("2026-07");
const AUG = month("2026-08");
const SEP = month("2026-09");
const OCT = month("2026-10");

/**
 * Two baseline months of the same length as October, so period length
 * plays no part unless a test is about it.
 */
function input(
  current: UsageRecord[],
  baselineOf: (period: typeof SEP) => UsageRecord[],
  invoiceUsd: number | null = null
): DetectorInput {
  return {
    period: OCT,
    current,
    baselines: [AUG, JUL].map((period) => ({
      period,
      records: baselineOf(period)
    })),
    invoiceMicros: invoiceUsd === null ? null : fromUsd(invoiceUsd)
  };
}

const ids = (result: ReturnType<typeof runDetectors>) =>
  result.findings.map((finding) => finding.detector);

describe("usage-spike (UC-1)", () => {
  const spiking = daily("Workers", OCT, 4, { overrides: { 12: 90, 13: 110 } });
  const result = runDetectors(input(spiking, (p) => daily("Workers", p, 4)));
  const spike = result.findings.find((f) => f.detector === "usage-spike");

  it("finds the days that cost several times the usual", () => {
    expect(spike).toMatchObject({
      kind: "account_data",
      direction: "increase",
      service: "Workers",
      impactMicros: fromUsd(192)
    });
    expect(spike?.evidence.map((e) => e.date)).toEqual([
      "2026-10-12",
      "2026-10-13"
    ]);
  });

  it("carries the quantity and cost of each spike day as evidence (G-5)", () => {
    expect(spike?.evidence[0]).toEqual({
      date: "2026-10-12",
      quantity: 90_000_000,
      unit: "requests",
      costMicros: fromUsd(90)
    });
  });

  it("states the finding from a template, with formatted amounts", () => {
    expect(spike?.statement).toBe(
      "Workers cost $200.00 over 2 days (2026-10-12 to 2026-10-13), against a usual $4.00 a day: $192.00 above usual."
    );
  });

  it("leaves nothing unexplained when the spike is the whole change", () => {
    expect(result.unexplainedMicros).toBe(0);
  });

  it("ignores a rise below the spike multiple", () => {
    const mild = daily("Workers", OCT, 4, { overrides: { 12: 9 } });
    expect(
      ids(runDetectors(input(mild, (p) => daily("Workers", p, 4))))
    ).toEqual([]);
  });

  it("ignores a spike too small to matter", () => {
    const tiny = daily("KV", OCT, 0.01, { overrides: { 5: 0.2 } });
    expect(ids(runDetectors(input(tiny, (p) => daily("KV", p, 0.01))))).toEqual(
      []
    );
  });
});

describe("usage-drop (UC-2)", () => {
  it("finds a service that cost less than half its usual", () => {
    const result = runDetectors(
      input(daily("Workers", OCT, 1), (p) => daily("Workers", p, 4))
    );
    expect(result.findings[0]).toMatchObject({
      detector: "usage-drop",
      direction: "decrease",
      service: "Workers",
      impactMicros: fromUsd(31 - 124)
    });
    expect(result.findings[0]?.statement).toBe(
      "Workers cost $31.00 this period against a usual $124.00: $93.00 lower."
    );
    expect(result.unexplainedMicros).toBe(0);
  });

  it("reports nothing for a small decrease, leaving it unexplained (G-4)", () => {
    const result = runDetectors(
      input(daily("Workers", OCT, 3.6), (p) => daily("Workers", p, 4))
    );
    expect(result.findings).toEqual([]);
    expect(result.unexplainedMicros).toBe(fromUsd(111.6 - 124));
  });
});

describe("new-service and removed-service", () => {
  const base = (p: typeof SEP) => [
    ...daily("Workers", p, 4),
    ...daily("R2", p, 1)
  ];

  it("finds a service charged for the first time", () => {
    const current = [
      ...daily("Workers", OCT, 4),
      ...daily("R2", OCT, 1),
      ...daily("Stream", OCT, 2)
    ];
    const finding = runDetectors(input(current, base)).findings.find(
      (f) => f.detector === "new-service"
    );
    expect(finding).toMatchObject({
      direction: "increase",
      service: "Stream",
      impactMicros: fromUsd(62)
    });
    expect(finding?.statement).toBe(
      "Stream was charged for the first time, from 2026-10-01: $62.00."
    );
  });

  it("finds a service that is no longer charged", () => {
    const finding = runDetectors(
      input(daily("Workers", OCT, 4), base)
    ).findings.find((f) => f.detector === "removed-service");
    expect(finding).toMatchObject({
      direction: "decrease",
      service: "R2",
      impactMicros: fromUsd(-31)
    });
  });

  it("does not call a service removed if it was missing from a baseline period", () => {
    const patchy = {
      ...input(daily("Workers", OCT, 4), base),
      baselines: [
        { period: SEP, records: base(SEP) },
        { period: AUG, records: daily("Workers", AUG, 4) }
      ]
    };
    expect(ids(runDetectors(patchy))).not.toContain("removed-service");
  });
});

describe("quantity-step: an included allowance ran out", () => {
  it("finds the first day usage went past the allowance", () => {
    const within = (p: typeof SEP) =>
      daily("Workers AI", p, 0, {
        metric: "neurons",
        unit: "neurons",
        billablePerDay: 0
      }).map((r) => ({ ...r, quantity: 8_000 }));
    const current = within(OCT).map((r, i) =>
      i >= 19
        ? {
            ...r,
            quantity: 30_000,
            billableQuantity: 20_000,
            costMicros: fromUsd(0.22)
          }
        : r
    );
    const finding = runDetectors(input(current, within)).findings.find(
      (f) => f.detector === "quantity-step"
    );
    expect(finding).toMatchObject({
      direction: "increase",
      service: "Workers AI",
      impactMicros: fromUsd(0.22 * 12)
    });
    expect(finding?.statement).toBe(
      "Workers AI neurons went past the included allowance on 2026-10-20; usage beyond it cost $2.64."
    );
  });

  it("stays silent when the source does not report billable quantity", () => {
    const result = runDetectors(
      input(daily("Workers", OCT, 4), (p) => daily("Workers", p, 4))
    );
    expect(ids(result)).not.toContain("quantity-step");
  });
});

describe("zone-change", () => {
  const base = (p: typeof SEP) =>
    daily("Workers", p, 4, { zone: "example.com" });

  it("finds charges for a zone that had none before", () => {
    const current = [
      ...base(OCT),
      ...daily("Workers", OCT, 2, { zone: "new.example" })
    ];
    const finding = runDetectors(input(current, base)).findings.find(
      (f) => f.detector === "zone-change"
    );
    expect(finding).toMatchObject({
      direction: "increase",
      impactMicros: fromUsd(62)
    });
    expect(finding?.statement).toBe(
      "Zone new.example has charges this period and had none before: $62.00."
    );
  });

  it("counts a new zone's charges as explained, not as a remainder", () => {
    const current = [
      ...base(OCT),
      ...daily("Workers", OCT, 2, { zone: "new.example" })
    ];
    const result = runDetectors(input(current, base));
    expect(result.findings.map((f) => f.detector)).toEqual(["zone-change"]);
    expect(result.unexplainedMicros).toBe(0);
  });

  it("does not count a zone's charges twice when a spike already explains them", () => {
    const current = [
      ...base(OCT),
      ...daily("Workers", OCT, 0, {
        zone: "new.example",
        overrides: { 5: 100 }
      })
    ];
    const result = runDetectors(input(current, base));
    expect(result.findings.map((f) => f.detector).sort()).toEqual([
      "usage-spike",
      "zone-change"
    ]);
    // The spike and the zone finding describe the same $100.
    expect(result.unexplainedMicros).toBe(0);
  });

  it("finds a zone whose charges stopped", () => {
    const finding = runDetectors(
      input(daily("Workers", OCT, 4, { zone: "other.example" }), base)
    ).findings.find(
      (f) => f.detector === "zone-change" && f.direction === "decrease"
    );
    expect(finding?.impactMicros).toBe(fromUsd(-124));
  });
});

describe("period-length", () => {
  it("finds a period with fewer charged days than usual", () => {
    const baselines = [month("2026-01"), month("2026-03")].map((period) => ({
      period,
      records: daily("Workers", period, 10)
    }));
    const result = runDetectors({
      period: month("2026-02"),
      current: daily("Workers", month("2026-02"), 10),
      baselines,
      invoiceMicros: null
    });
    expect(result.findings[0]).toMatchObject({
      detector: "period-length",
      direction: "decrease",
      service: null,
      impactMicros: fromUsd(-30)
    });
    expect(result.findings[0]?.statement).toBe(
      "This period has 28 days against a usual 31. At the usual $10.00 a day that is $30.00 lower."
    );
  });

  it("is silent when the period lengths match", () => {
    const result = runDetectors(
      input(daily("Workers", OCT, 4), () => daily("Workers", JUL, 4))
    );
    expect(ids(result)).not.toContain("period-length");
  });
});

describe("invoice-variance and reconcile (UC-6)", () => {
  it("matches an invoice within tolerance", () => {
    expect(reconcile(fromUsd(124), fromUsd(124.5))).toEqual({
      status: "matched",
      varianceMicros: fromUsd(0.5)
    });
  });

  it("reports a variance beyond tolerance", () => {
    expect(reconcile(fromUsd(124), fromUsd(150))).toEqual({
      status: "variance",
      varianceMicros: fromUsd(26)
    });
  });

  it("scales the tolerance with a large invoice", () => {
    expect(reconcile(fromUsd(10_000), fromUsd(10_050)).status).toBe("matched");
    expect(reconcile(fromUsd(10_000), fromUsd(10_200)).status).toBe("variance");
  });

  it("says so when there is no invoice", () => {
    expect(reconcile(fromUsd(124), null)).toEqual({ status: "no_invoice" });
  });

  it("flags an invoice that differs from the summed usage", () => {
    const result = runDetectors(
      input(daily("Workers", OCT, 4), (p) => daily("Workers", p, 4), 150)
    );
    expect(result.findings).toEqual([
      expect.objectContaining({
        detector: "invoice-variance",
        direction: "increase",
        service: null,
        impactMicros: fromUsd(26),
        statement:
          "The invoice is $150.00 and the usage for the period adds up to $124.00: a difference of $26.00."
      })
    ]);
  });

  it("is silent when the invoice matches or is absent", () => {
    const match = runDetectors(
      input(daily("Workers", OCT, 4), (p) => daily("Workers", p, 4), 124)
    );
    expect(match.findings).toEqual([]);
  });
});

describe("records the source gave no cost for", () => {
  it("are left out of the sums and never treated as charges", () => {
    const uncosted = daily("Workers", OCT, 0, { metric: "cpu" }).map((r) => ({
      ...r,
      costMicros: null
    }));
    const current = [
      ...uncosted,
      ...daily("Workers", OCT, 4, { overrides: { 12: 90 } }),
      ...uncosted.map((r) => ({ ...r, service: "Stream" })),
      ...daily("Stream", OCT, 2, { overrides: { 1: 0 } })
    ];
    const result = runDetectors(input(current, (p) => daily("Workers", p, 4)));
    const spike = result.findings.find((f) => f.detector === "usage-spike");
    expect(spike?.impactMicros).toBe(fromUsd(86));
    expect(spike?.evidence[0]?.costMicros).toBe(fromUsd(90));
    const added = result.findings.find((f) => f.detector === "new-service");
    expect(added?.statement).toBe(
      "Stream was charged for the first time, from 2026-10-02: $60.00."
    );
  });
});

describe("thresholds", () => {
  it("ignores usage past an allowance that cost almost nothing", () => {
    const within = (p: typeof SEP) =>
      daily("KV", p, 0, { billablePerDay: 0 }).map((r) => ({
        ...r,
        quantity: 5
      }));
    const current = within(OCT).map((r, i) =>
      i === 3 ? { ...r, billableQuantity: 1, costMicros: fromUsd(0.01) } : r
    );
    expect(ids(runDetectors(input(current, within)))).toEqual([]);
  });

  it("ignores days where the source does not report billable quantity", () => {
    const within = (p: typeof SEP) =>
      daily("KV", p, 0, { billablePerDay: 0 }).map((r) => ({
        ...r,
        quantity: 5
      }));
    const current = within(OCT).map((r) => ({ ...r, billableQuantity: null }));
    expect(ids(runDetectors(input(current, within)))).toEqual([]);
  });

  it("ignores a period-length difference that costs almost nothing", () => {
    const result = runDetectors({
      period: month("2026-02"),
      current: daily("KV", month("2026-02"), 0.01),
      baselines: [month("2026-01"), month("2026-03")].map((period) => ({
        period,
        records: daily("KV", period, 0.01)
      })),
      invoiceMicros: null
    });
    expect(ids(result)).toEqual([]);
  });

  it("describes a longer period against a usual length that is not whole", () => {
    const result = runDetectors({
      period: month("2026-03"),
      current: daily("Workers", month("2026-03"), 10),
      baselines: [month("2026-02"), month("2026-01")].map((period) => ({
        period,
        records: daily("Workers", period, 10)
      })),
      invoiceMicros: null
    });
    expect(result.findings[0]?.statement).toBe(
      "This period has 31 days against a usual 29.5. At the usual $10.00 a day that is $15.00 higher."
    );
  });
});

describe("runDetectors", () => {
  it("orders findings by the size of their impact", () => {
    const current = [
      ...daily("Workers", OCT, 4, { overrides: { 3: 60 } }),
      ...daily("Stream", OCT, 10)
    ];
    const result = runDetectors(input(current, (p) => daily("Workers", p, 4)));
    expect(ids(result)).toEqual(["new-service", "usage-spike"]);
    expect(result.unexplainedMicros).toBe(0);
  });

  it("finds nothing in a steady account and leaves nothing unexplained", () => {
    const result = runDetectors(
      input(daily("Workers", OCT, 4), (p) => daily("Workers", p, 4))
    );
    expect(result).toEqual({ findings: [], unexplainedMicros: 0 });
  });

  it("compares nothing without enough history, but still checks the invoice", () => {
    const result = runDetectors({
      period: OCT,
      current: daily("Workers", OCT, 4, { overrides: { 3: 90 } }),
      baselines: [{ period: SEP, records: daily("Workers", SEP, 4) }],
      invoiceMicros: fromUsd(500)
    });
    expect(ids(result)).toEqual(["invoice-variance"]);
    expect(result.unexplainedMicros).toBeNull();
  });

  it("does not report an explained amount larger than the service's change", () => {
    // Spike days are offset by cheaper days, so the service is up only $18.
    const current = daily("Workers", OCT, 2, { overrides: { 10: 82 } });
    const result = runDetectors(input(current, (p) => daily("Workers", p, 4)));
    expect(ids(result)).toContain("usage-spike");
    expect(result.unexplainedMicros).toBe(0);
  });
});

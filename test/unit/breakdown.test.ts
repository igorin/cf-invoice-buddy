import { describe, expect, it } from "vitest";
import {
  compareToBaseline,
  dailyCost,
  totalCost,
  totalsByService
} from "../../src/domain/breakdown";
import { fromUsd } from "../../src/domain/money";
import { daily, month } from "../fixtures/usage";

const AUG = month("2026-08");
const SEP = month("2026-09");
const OCT = month("2026-10");

describe("totalCost", () => {
  it("sums the cost of every record", () => {
    const records = [...daily("Workers", OCT, 2), ...daily("R2", OCT, 1)];
    expect(totalCost(records)).toEqual({
      costMicros: fromUsd(93),
      uncostedRecords: 0
    });
  });

  it("counts records without a cost, and does not treat them as zero-cost", () => {
    const [first, ...rest] = daily("Workers", OCT, 2);
    const records = [{ ...first!, costMicros: null }, ...rest];
    expect(totalCost(records)).toEqual({
      costMicros: fromUsd(60),
      uncostedRecords: 1
    });
  });

  it("is zero for no records", () => {
    expect(totalCost([])).toEqual({ costMicros: 0, uncostedRecords: 0 });
  });
});

describe("totalsByService (UC-1)", () => {
  it("lists services by cost, largest first", () => {
    const records = [...daily("R2", OCT, 1), ...daily("Workers", OCT, 2)];
    expect(totalsByService(records)).toEqual([
      { service: "Workers", costMicros: fromUsd(62), uncostedRecords: 0 },
      { service: "R2", costMicros: fromUsd(31), uncostedRecords: 0 }
    ]);
  });

  it("orders equal costs by name so the result is stable", () => {
    const records = [...daily("Zeta", OCT, 1), ...daily("Alpha", OCT, 1)];
    expect(totalsByService(records).map((t) => t.service)).toEqual([
      "Alpha",
      "Zeta"
    ]);
  });
});

describe("dailyCost (UC-1)", () => {
  it("returns one entry per day in date order, summing metrics and zones", () => {
    const records = [
      ...daily("Workers", OCT, 2, { metric: "requests" }),
      ...daily("Workers", OCT, 1, { metric: "cpu", zone: "example.com" }),
      ...daily("R2", OCT, 5)
    ];
    const series = dailyCost(records, "Workers");
    expect(series).toHaveLength(31);
    expect(series[0]).toEqual({ date: "2026-10-01", costMicros: fromUsd(3) });
    expect(series.at(-1)?.date).toBe("2026-10-31");
  });

  it("leaves out records without a cost", () => {
    const [first, ...rest] = daily("Workers", OCT, 2);
    const series = dailyCost(
      [{ ...first!, costMicros: null }, ...rest],
      "Workers"
    );
    expect(series[0]).toEqual({ date: "2026-10-01", costMicros: 0 });
  });

  it("is empty for a service with no records", () => {
    expect(dailyCost(daily("R2", OCT, 5), "Workers")).toEqual([]);
  });
});

describe("compareToBaseline (UC-1, UC-2)", () => {
  const baselines = [
    [...daily("Workers", SEP, 4), ...daily("R2", SEP, 1)],
    [...daily("Workers", AUG, 4), ...daily("R2", AUG, 1)]
  ];

  it("compares each service with its mean over the baseline periods", () => {
    const current = [...daily("Workers", OCT, 12), ...daily("R2", OCT, 1)];
    const result = compareToBaseline(current, baselines);
    expect(result).toMatchObject({
      comparable: true,
      totalMicros: fromUsd(403),
      baselineMicros: fromUsd(152.5),
      deltaMicros: fromUsd(250.5)
    });
    if (!result.comparable) throw new Error("expected a comparison");
    expect(result.services).toEqual([
      {
        service: "Workers",
        currentMicros: fromUsd(372),
        baselineMicros: fromUsd(122),
        deltaMicros: fromUsd(250)
      },
      {
        service: "R2",
        currentMicros: fromUsd(31),
        baselineMicros: fromUsd(30.5),
        deltaMicros: fromUsd(0.5)
      }
    ]);
  });

  it("keeps the service deltas summing to the total delta", () => {
    const thirds = [
      daily("A", AUG, 1 / 3),
      daily("A", SEP, 2 / 3),
      daily("A", month("2026-07"), 1 / 7)
    ];
    const result = compareToBaseline(daily("A", OCT, 1), thirds);
    if (!result.comparable) throw new Error("expected a comparison");
    const summed = result.services.reduce((n, s) => n + s.deltaMicros, 0);
    expect(summed).toBe(result.deltaMicros);
  });

  it("includes a service that is new and one that has gone", () => {
    const current = [...daily("Workers", OCT, 4), ...daily("Stream", OCT, 2)];
    const result = compareToBaseline(current, baselines);
    if (!result.comparable) throw new Error("expected a comparison");
    const byName = Object.fromEntries(
      result.services.map((s) => [s.service, s])
    );
    expect(byName.Stream).toMatchObject({ baselineMicros: 0 });
    expect(byName.R2).toMatchObject({ currentMicros: 0 });
  });

  it("orders services by the size of their change, whichever direction", () => {
    const current = [...daily("Workers", OCT, 4.5), ...daily("R2", OCT, 0)];
    const result = compareToBaseline(current, baselines);
    if (!result.comparable) throw new Error("expected a comparison");
    expect(result.services.map((s) => s.service)).toEqual(["R2", "Workers"]);
  });

  it("reports a percentage change, or null from a zero baseline", () => {
    const flat = compareToBaseline(daily("Workers", OCT, 8), baselines);
    expect(flat.comparable && flat.percent).toBeCloseTo(62.62, 1);
    const fromZero = compareToBaseline(daily("X", OCT, 1), [[], []]);
    expect(fromZero.comparable && fromZero.percent).toBeNull();
  });

  it.each([0, 1])(
    "does not invent a baseline from %s prior period(s)",
    (count) => {
      const result = compareToBaseline(
        daily("Workers", OCT, 4),
        baselines.slice(0, count)
      );
      expect(result).toEqual({
        comparable: false,
        reason: "insufficient_history",
        totalMicros: fromUsd(124)
      });
    }
  );
});

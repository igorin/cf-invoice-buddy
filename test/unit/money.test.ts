import { describe, expect, it } from "vitest";
import {
  addMicros,
  formatUsd,
  fromUsd,
  micros,
  percentChange,
  subtractMicros,
  sumMicros
} from "../../src/domain/money";

describe("micros (NFR-Q3)", () => {
  it("accepts a whole number of micro-dollars", () => {
    expect(micros(412_000_000)).toBe(412_000_000);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])(
    "rejects %s",
    (value) => {
      expect(() => micros(value)).toThrow(RangeError);
    }
  );
});

describe("fromUsd", () => {
  it("converts dollars to micro-dollars", () => {
    expect(fromUsd(412)).toBe(412_000_000);
  });

  it("rounds a float artefact to the nearest micro-dollar", () => {
    expect(fromUsd(0.1 + 0.2)).toBe(300_000);
  });

  it("converts a negative amount", () => {
    expect(fromUsd(-1.5)).toBe(-1_500_000);
  });

  it("rejects a non-finite amount", () => {
    expect(() => fromUsd(Number.NaN)).toThrow(RangeError);
  });
});

describe("arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(addMicros(fromUsd(0.1), fromUsd(0.2))).toBe(300_000);
    expect(subtractMicros(fromUsd(150), fromUsd(412))).toBe(-262_000_000);
  });

  it("sums a list, and an empty list is zero", () => {
    expect(sumMicros([fromUsd(1), fromUsd(2.5)])).toBe(3_500_000);
    expect(sumMicros([])).toBe(0);
  });
});

describe("formatUsd (G-1: the model copies this string)", () => {
  it.each([
    [412, "$412.00"],
    [0, "$0.00"],
    [1234567.891, "$1,234,567.89"],
    [-262, "-$262.00"],
    [0.005, "$0.01"],
    [0.004, "$0.00"],
    [-0.004, "$0.00"],
    [999.995, "$1,000.00"]
  ])("formats %s as %s", (usd, text) => {
    expect(formatUsd(fromUsd(usd))).toBe(text);
  });
});

describe("percentChange", () => {
  it("returns the change from the first amount to the second", () => {
    expect(percentChange(fromUsd(150), fromUsd(412))).toBeCloseTo(174.67, 2);
    expect(percentChange(fromUsd(200), fromUsd(100))).toBe(-50);
  });

  it("returns null when there is no starting amount to compare with", () => {
    expect(percentChange(fromUsd(0), fromUsd(5))).toBeNull();
  });
});

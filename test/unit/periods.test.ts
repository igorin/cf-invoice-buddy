import { describe, expect, it } from "vitest";
import {
  addDays,
  daysInPeriod,
  isInPeriod,
  isOpen,
  isoDate,
  periodContaining,
  precedingPeriods,
  previousPeriod
} from "../../src/domain/periods";

const d = isoDate;

describe("isoDate", () => {
  it("accepts a real calendar date", () => {
    expect(isoDate("2026-02-28")).toBe("2026-02-28");
  });

  it.each(["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", "", "tomorrow"])(
    "rejects %s",
    (value) => {
      expect(() => isoDate(value)).toThrow(RangeError);
    }
  );
});

describe("addDays", () => {
  it("crosses month and year ends", () => {
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
  });

  it("handles a leap day", () => {
    expect(addDays(d("2028-02-28"), 1)).toBe("2028-02-29");
  });
});

describe("periodContaining", () => {
  it("starts on the anchor day and ends before the next one", () => {
    expect(periodContaining(d("2026-10-20"), 10)).toEqual({
      start: "2026-10-10",
      end: "2026-11-10"
    });
  });

  it("puts a date before the anchor day in the previous period", () => {
    expect(periodContaining(d("2026-10-05"), 10)).toEqual({
      start: "2026-09-10",
      end: "2026-10-10"
    });
  });

  it("includes the anchor day itself", () => {
    expect(periodContaining(d("2026-10-10"), 10).start).toBe("2026-10-10");
  });

  it("clamps an anchor day past the end of a short month", () => {
    expect(periodContaining(d("2026-02-28"), 31)).toEqual({
      start: "2026-02-28",
      end: "2026-03-31"
    });
    expect(periodContaining(d("2026-02-15"), 31)).toEqual({
      start: "2026-01-31",
      end: "2026-02-28"
    });
  });

  it("crosses a year end", () => {
    expect(periodContaining(d("2027-01-03"), 15)).toEqual({
      start: "2026-12-15",
      end: "2027-01-15"
    });
  });

  it.each([0, 32, 1.5])("rejects anchor day %s", (anchor) => {
    expect(() => periodContaining(d("2026-10-05"), anchor)).toThrow(RangeError);
  });
});

describe("previousPeriod and precedingPeriods", () => {
  const october = periodContaining(d("2026-10-20"), 10);

  it("returns the period that ends where this one starts", () => {
    expect(previousPeriod(october, 10)).toEqual({
      start: "2026-09-10",
      end: "2026-10-10"
    });
  });

  it("lists preceding periods, most recent first", () => {
    expect(precedingPeriods(october, 10, 3).map((p) => p.start)).toEqual([
      "2026-09-10",
      "2026-08-10",
      "2026-07-10"
    ]);
  });

  it("returns none when asked for none", () => {
    expect(precedingPeriods(october, 10, 0)).toEqual([]);
  });
});

describe("period queries", () => {
  const period = { start: d("2026-02-01"), end: d("2026-03-01") };

  it("counts the days in a period", () => {
    expect(daysInPeriod(period)).toBe(28);
  });

  it("treats the end date as outside the period", () => {
    expect(isInPeriod(d("2026-02-01"), period)).toBe(true);
    expect(isInPeriod(d("2026-02-28"), period)).toBe(true);
    expect(isInPeriod(d("2026-03-01"), period)).toBe(false);
    expect(isInPeriod(d("2026-01-31"), period)).toBe(false);
  });

  it("is open until its end date arrives", () => {
    expect(isOpen(period, d("2026-02-28"))).toBe(true);
    expect(isOpen(period, d("2026-03-01"))).toBe(false);
  });
});

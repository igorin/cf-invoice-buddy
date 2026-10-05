import { fromUsd } from "../../src/domain/money";
import {
  addDays,
  daysInPeriod,
  isoDate,
  periodContaining,
  type BillingPeriod
} from "../../src/domain/periods";
import type { UsageRecord } from "../../src/domain/usage";

/** Fixture accounts bill on the first of the month. */
export const ANCHOR_DAY = 1;

/** The billing period for a month given as YYYY-MM. */
export function month(yearMonth: string): BillingPeriod {
  return periodContaining(isoDate(`${yearMonth}-15`), ANCHOR_DAY);
}

type DailyOptions = Readonly<{
  metric?: string;
  unit?: string;
  zone?: string | null;
  /** Units of usage per dollar, to derive a quantity from the cost. */
  unitsPerUsd?: number;
  /** Cost for specific days, by day of period (1-based), replacing the default. */
  overrides?: Readonly<Record<number, number>>;
  /** Billable quantity per day; null when the source does not report it. */
  billablePerDay?: number | null;
}>;

/** One usage record per day of the period for a service at a daily cost. */
export function daily(
  service: string,
  period: BillingPeriod,
  usdPerDay: number,
  options: DailyOptions = {}
): UsageRecord[] {
  const unitsPerUsd = options.unitsPerUsd ?? 1_000_000;
  return Array.from({ length: daysInPeriod(period) }, (_, index) => {
    const usd = options.overrides?.[index + 1] ?? usdPerDay;
    return {
      date: addDays(period.start, index),
      service,
      metric: options.metric ?? "requests",
      zone: options.zone ?? null,
      quantity: Math.round(usd * unitsPerUsd),
      unit: options.unit ?? "requests",
      billableQuantity:
        options.billablePerDay === undefined ? null : options.billablePerDay,
      costMicros: fromUsd(usd)
    };
  });
}

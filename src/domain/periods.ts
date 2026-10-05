/**
 * Billing periods. Cloudflare bills on a cycle anchored to a day of the
 * month, not the calendar month, and all billing dates are UTC.
 */

declare const isoDateBrand: unique symbol;

/** A calendar date as YYYY-MM-DD, in UTC. */
export type IsoDate = string & { readonly [isoDateBrand]: true };

/** A billing period. `end` is the first day of the next period. */
export type BillingPeriod = Readonly<{ start: IsoDate; end: IsoDate }>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;
const MAX_ANCHOR_DAY = 31;

function toUtcMs(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function fromUtcMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10) as IsoDate;
}

/** Validates a YYYY-MM-DD string as a real calendar date. */
export function isoDate(value: string): IsoDate {
  const ms = ISO_DATE.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  // Date.parse accepts 2026-02-30 and rolls it over; reject that.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Not a calendar date: ${value}`);
  }
  return value as IsoDate;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * MS_PER_DAY);
}

/** The anchor date in a given month, clamped to the month's last day. */
function anchorDate(
  year: number,
  monthIndex: number,
  anchorDay: number
): IsoDate {
  const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return fromUtcMs(Date.UTC(year, monthIndex, Math.min(anchorDay, lastDay)));
}

function assertAnchorDay(anchorDay: number): void {
  if (
    !Number.isInteger(anchorDay) ||
    anchorDay < 1 ||
    anchorDay > MAX_ANCHOR_DAY
  ) {
    throw new RangeError("Anchor day must be a whole number from 1 to 31");
  }
}

/** The billing period that contains a date, for a billing cycle anchor day. */
export function periodContaining(
  date: IsoDate,
  anchorDay: number
): BillingPeriod {
  assertAnchorDay(anchorDay);
  const at = new Date(toUtcMs(date));
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const thisAnchor = anchorDate(year, month, anchorDay);
  return date >= thisAnchor
    ? { start: thisAnchor, end: anchorDate(year, month + 1, anchorDay) }
    : { start: anchorDate(year, month - 1, anchorDay), end: thisAnchor };
}

export function previousPeriod(
  period: BillingPeriod,
  anchorDay: number
): BillingPeriod {
  return periodContaining(addDays(period.start, -1), anchorDay);
}

/** The periods before this one, most recent first. */
export function precedingPeriods(
  period: BillingPeriod,
  anchorDay: number,
  count: number
): ReadonlyArray<BillingPeriod> {
  const periods: BillingPeriod[] = [];
  let cursor = period;
  for (let i = 0; i < count; i++) {
    cursor = previousPeriod(cursor, anchorDay);
    periods.push(cursor);
  }
  return periods;
}

export function daysInPeriod(period: BillingPeriod): number {
  return Math.round((toUtcMs(period.end) - toUtcMs(period.start)) / MS_PER_DAY);
}

export function isInPeriod(date: IsoDate, period: BillingPeriod): boolean {
  return date >= period.start && date < period.end;
}

/** A period is open, and its figures partial, until its end date arrives. */
export function isOpen(period: BillingPeriod, today: IsoDate): boolean {
  return today < period.end;
}

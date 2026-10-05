/**
 * Money as whole micro-dollars (spec NFR-Q3). All arithmetic is on integers;
 * a float only appears when converting an API amount in, and is rounded once.
 */

declare const microsBrand: unique symbol;

/** A whole number of micro-dollars. 1 USD = 1,000,000. */
export type Micros = number & { readonly [microsBrand]: true };

export const MICROS_PER_USD = 1_000_000;
const MICROS_PER_CENT = 10_000;
const CENTS_PER_USD = 100;

/** Validates a number as micro-dollars. */
export function micros(value: number): Micros {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Micro-dollar amounts must be safe integers");
  }
  return value as Micros;
}

/** Converts a dollar amount from an API to micro-dollars, rounding once. */
export function fromUsd(usd: number): Micros {
  if (!Number.isFinite(usd)) {
    throw new RangeError("Dollar amount must be finite");
  }
  return micros(Math.round(usd * MICROS_PER_USD));
}

export function addMicros(a: Micros, b: Micros): Micros {
  return micros(a + b);
}

export function subtractMicros(a: Micros, b: Micros): Micros {
  return micros(a - b);
}

export function sumMicros(values: ReadonlyArray<Micros>): Micros {
  return micros(values.reduce((total, value) => total + value, 0));
}

/**
 * Formats an amount as dollars and cents, for example "$1,234.50" or
 * "-$262.00". Tools return this string so the model never formats money.
 */
export function formatUsd(value: Micros): string {
  const totalCents = Math.round(Math.abs(value) / MICROS_PER_CENT);
  const dollars = Math.floor(totalCents / CENTS_PER_USD);
  const cents = String(totalCents % CENTS_PER_USD).padStart(2, "0");
  const sign = value < 0 && totalCents > 0 ? "-" : "";
  return `${sign}$${dollars.toLocaleString("en-US")}.${cents}`;
}

/** Percentage change from one amount to another, or null from a zero start. */
export function percentChange(from: Micros, to: Micros): number | null {
  if (from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

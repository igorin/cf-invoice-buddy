import type { Micros } from "./money";
import type { IsoDate } from "./periods";

/**
 * One day of metered usage for one metric of one service. Quantity is real
 * usage, including usage inside a free allowance. Cost is null when the
 * source gives none; null is never read as zero (spec UC-9).
 */
export type UsageRecord = Readonly<{
  date: IsoDate;
  service: string;
  metric: string;
  zone: string | null;
  quantity: number;
  unit: string;
  /** The part of the quantity that is charged for, when the source reports it. */
  billableQuantity: number | null;
  costMicros: Micros | null;
}>;

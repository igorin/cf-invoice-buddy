import type { Micros } from "./money";
import type { BillingPeriod, IsoDate } from "./periods";
import type { UsageRecord } from "./usage";

/** What the detectors take in and give back (spec section 6). */

export type DetectorId =
  | "usage-spike"
  | "usage-drop"
  | "new-service"
  | "removed-service"
  | "quantity-step"
  | "zone-change"
  | "period-length"
  | "invoice-variance";

export type Evidence = Readonly<{
  date: IsoDate;
  quantity: number;
  unit: string;
  costMicros: Micros;
}>;

export type Finding = Readonly<{
  detector: DetectorId;
  kind: "account_data";
  direction: "increase" | "decrease";
  /** Null for findings about the whole account, such as period length. */
  service: string | null;
  impactMicros: Micros;
  evidence: ReadonlyArray<Evidence>;
  statement: string;
}>;

export type DetectorInput = Readonly<{
  period: BillingPeriod;
  current: ReadonlyArray<UsageRecord>;
  baselines: ReadonlyArray<
    Readonly<{ period: BillingPeriod; records: ReadonlyArray<UsageRecord> }>
  >;
  invoiceMicros: Micros | null;
}>;

export type DetectorResult = Readonly<{
  findings: ReadonlyArray<Finding>;
  /** The part of the change no finding accounts for; null without a baseline. */
  unexplainedMicros: Micros | null;
}>;

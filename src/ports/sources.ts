import type { Plan } from "../domain/allowances";
import type { Micros } from "../domain/money";
import type { IsoDate } from "../domain/periods";
import type { UsageRecord } from "../domain/usage";
import type { BillingState, SourceStatus } from "../domain/usage-summary";

/** Usage quantities per product and day, with a status for each product. */
export type UsageFetch = Readonly<{
  records: ReadonlyArray<UsageRecord>;
  sources: ReadonlyArray<SourceStatus>;
}>;

export interface UsageSource {
  /** Both dates are inclusive. A product that cannot be read is reported, not zeroed. */
  fetchUsage(from: IsoDate, to: IsoDate): Promise<UsageFetch>;
}

export type Invoice = Readonly<{
  periodStart: IsoDate;
  periodEnd: IsoDate;
  amountMicros: Micros;
}>;

export type BillingInfo = Readonly<{
  billing: BillingState;
  plan: Plan;
  invoices: ReadonlyArray<Invoice>;
}>;

export interface BillingSource {
  fetchBilling(): Promise<BillingInfo>;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

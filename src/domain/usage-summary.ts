import { findAllowance, type Plan } from "./allowances";
import { formatUsd, micros, type Micros } from "./money";
import { isInPeriod, type BillingPeriod, type IsoDate } from "./periods";
import type { UsageRecord } from "./usage";

/**
 * The usage summary (spec UC-9): what the account used and what it was
 * charged, per product and metric. It works with no invoice and a $0 bill.
 * Unknown is never shown as zero: a product whose source failed has no row,
 * and an amount the billing source did not give is "unavailable".
 */

export type SourceStatus = Readonly<{
  service: string;
  available: boolean;
  reason?: string;
}>;

export type BillingState =
  /** No usage-based subscription and no invoices: there are no charges. */
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "costed" }>
  | Readonly<{ status: "unavailable"; reason: string }>;

export type Billed =
  | Readonly<{ status: "amount"; micros: Micros; text: string }>
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "unavailable" }>;

export type SummaryRow = Readonly<{
  service: string;
  metric: string;
  unit: string;
  /** Total for the billing period so far. */
  quantity: number;
  /** Total for today. */
  today: number;
  allowance: Readonly<{
    amount: number;
    per: "day" | "month";
    used: number;
    share: number;
  }> | null;
  billed: Billed;
}>;

export type UsageSummary = Readonly<{
  period: BillingPeriod;
  rows: ReadonlyArray<SummaryRow>;
  unavailable: ReadonlyArray<Readonly<{ service: string; reason: string }>>;
  billing: BillingState;
}>;

export type UsageSummaryInput = Readonly<{
  records: ReadonlyArray<UsageRecord>;
  period: BillingPeriod;
  today: IsoDate;
  plan: Plan;
  sources: ReadonlyArray<SourceStatus>;
  billing: BillingState;
}>;

function billedFor(
  records: ReadonlyArray<UsageRecord>,
  billing: BillingState
): Billed {
  if (billing.status === "none") return { status: "none" };
  const costs = records.map((record) => record.costMicros);
  if (billing.status === "unavailable" || costs.includes(null)) {
    return { status: "unavailable" };
  }
  const total = micros(costs.reduce<number>((n, cost) => n + (cost ?? 0), 0));
  return { status: "amount", micros: total, text: formatUsd(total) };
}

function rowFor(
  records: ReadonlyArray<UsageRecord>,
  first: UsageRecord,
  input: UsageSummaryInput
): SummaryRow {
  const quantity = records.reduce((n, record) => n + record.quantity, 0);
  const today = records
    .filter((record) => record.date === input.today)
    .reduce((n, record) => n + record.quantity, 0);
  const allowance = findAllowance(input.plan, first.service, first.metric);
  const used = allowance?.per === "day" ? today : quantity;
  return {
    service: first.service,
    metric: first.metric,
    unit: first.unit,
    quantity,
    today,
    allowance: allowance
      ? {
          amount: allowance.amount,
          per: allowance.per,
          used,
          share: used / allowance.amount
        }
      : null,
    billed: billedFor(records, input.billing)
  };
}

export function buildUsageSummary(input: UsageSummaryInput): UsageSummary {
  const failed = input.sources.filter((source) => !source.available);
  const failedServices = new Set(failed.map((source) => source.service));
  const groups = new Map<string, UsageRecord[]>();
  for (const record of input.records) {
    if (!isInPeriod(record.date, input.period)) continue;
    if (failedServices.has(record.service)) continue;
    const key = `${record.service}\u0000${record.metric}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const rows = [...groups.values()]
    .flatMap((records) =>
      records.slice(0, 1).map((first) => rowFor(records, first, input))
    )
    .sort(
      (a, b) =>
        a.service.localeCompare(b.service) || a.metric.localeCompare(b.metric)
    );
  return {
    period: input.period,
    rows,
    unavailable: failed.map((source) => ({
      service: source.service,
      reason: source.reason ?? "unknown"
    })),
    billing: input.billing
  };
}

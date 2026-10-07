import { ALLOWANCES, type Plan } from "./allowances";
import { formatUsd, fromUsd, micros, type Micros } from "./money";
import {
  daysInPeriod,
  isOpen,
  type BillingPeriod,
  type IsoDate
} from "./periods";
import type { UsageRecord } from "./usage";

/**
 * Plan comparison (spec UC-7): what a period's actual usage would have cost
 * on Workers Free and on Workers Paid, from a dated price table. Every
 * figure is an estimate at list price and is labelled as one (G-8).
 * Pure code: no Cloudflare imports.
 */

export type Rate = Readonly<{
  service: string;
  metric: string;
  unit: string;
  /** The price buys this many units beyond the included amount. */
  per: number;
  priceMicros: Micros;
}>;

/** Workers Paid list prices. Included amounts are in allowances.ts. */
export const PRICE_TABLE = {
  /** The date these were last read from the pages below. */
  checkedOn: "2026-10-07",
  urls: [
    "https://developers.cloudflare.com/workers/platform/pricing/",
    "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    "https://developers.cloudflare.com/workflows/reference/pricing/"
  ],
  paidBaseMicros: fromUsd(5),
  rates: [
    {
      service: "Workers",
      metric: "requests",
      unit: "requests",
      per: 1_000_000,
      priceMicros: fromUsd(0.3)
    },
    {
      service: "Workers AI",
      metric: "neurons",
      unit: "neurons",
      per: 1_000,
      priceMicros: fromUsd(0.011)
    },
    {
      service: "Durable Objects",
      metric: "requests",
      unit: "requests",
      per: 1_000_000,
      priceMicros: fromUsd(0.15)
    },
    {
      service: "Durable Objects",
      metric: "duration",
      unit: "GB-s",
      per: 1_000_000,
      priceMicros: fromUsd(12.5)
    },
    {
      service: "Durable Objects",
      metric: "rows read",
      unit: "rows",
      per: 1_000_000,
      priceMicros: fromUsd(0.001)
    },
    {
      service: "Durable Objects",
      metric: "rows written",
      unit: "rows",
      per: 1_000_000,
      priceMicros: fromUsd(1)
    },
    {
      service: "Workflows",
      metric: "steps",
      unit: "steps",
      per: 100_000,
      priceMicros: fromUsd(0.8)
    }
  ] satisfies ReadonlyArray<Rate>
} as const;

/** Billed by Cloudflare but not in the usage data this app reads. */
export const NOT_MEASURED = [
  "Workers CPU time",
  "Durable Objects stored data",
  "Workflows storage"
] as const;

export const PLAN_NAMES: Readonly<Record<Plan, string>> = {
  free: "Workers Free",
  paid: "Workers Paid"
};

export type PlanLine = Readonly<{
  service: string;
  metric: string;
  used: string;
  included: string;
  billable: string;
  rate: string;
  cost: string;
}>;

export type OverLimit = Readonly<{
  service: string;
  metric: string;
  limit: string;
  daysOver: number;
}>;

export type PlanEstimate = Readonly<{
  plan: Plan;
  name: string;
  total: string;
  base: string;
  lines: ReadonlyArray<PlanLine>;
  /** Free only: the daily limits the period's usage went over. */
  overLimit: ReadonlyArray<OverLimit>;
}>;

export type PlanComparison = Readonly<{
  month: string;
  partial: boolean;
  estimate: true;
  currentPlan: Plan;
  plans: ReadonlyArray<PlanEstimate>;
  /** Whether the period's usage stayed inside every Workers Free limit. */
  fitsFree: boolean;
  /** One sentence stating what the comparison shows, built here. */
  verdict: string;
  /** Usage with no rate in the price table, left out of the totals. */
  notPriced: ReadonlyArray<Readonly<{ service: string; metric: string }>>;
  notMeasured: ReadonlyArray<string>;
  notes: ReadonlyArray<string>;
  priceSource: Readonly<{ checkedOn: string; urls: ReadonlyArray<string> }>;
}>;

export type PlanInput = Readonly<{
  period: BillingPeriod;
  today: IsoDate;
  records: ReadonlyArray<UsageRecord>;
  currentPlan: Plan;
}>;

const amount = (value: number, unit: string): string =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit}`;

const key = (service: string, metric: string): string =>
  `${service}\u0000${metric}`;

type Metered = Readonly<{
  service: string;
  metric: string;
  total: number;
  byDay: ReadonlyMap<string, number>;
}>;

function meter(records: ReadonlyArray<UsageRecord>): Metered[] {
  const metered = new Map<
    string,
    {
      service: string;
      metric: string;
      total: number;
      byDay: Map<string, number>;
    }
  >();
  for (const record of records) {
    const id = key(record.service, record.metric);
    const entry = metered.get(id) ?? {
      service: record.service,
      metric: record.metric,
      total: 0,
      byDay: new Map<string, number>()
    };
    entry.total += record.quantity;
    entry.byDay.set(
      record.date,
      (entry.byDay.get(record.date) ?? 0) + record.quantity
    );
    metered.set(id, entry);
  }
  return [...metered.values()];
}

const allowanceOf = (plan: Plan, usage: Metered) =>
  ALLOWANCES.find(
    (allowance) =>
      allowance.plan === plan &&
      allowance.service === usage.service &&
      allowance.metric === usage.metric
  );

/** The quantity beyond what the plan includes, by day or by month. */
function beyond(usage: Metered, included: number, per: "day" | "month") {
  if (per === "month") return Math.max(0, usage.total - included);
  return [...usage.byDay.values()].reduce(
    (sum, day) => sum + Math.max(0, day - included),
    0
  );
}

function paidEstimate(usage: ReadonlyArray<Metered>): PlanEstimate {
  let totalMicros: number = PRICE_TABLE.paidBaseMicros;
  const lines: PlanLine[] = [];
  for (const rate of PRICE_TABLE.rates) {
    const used = usage.find(
      (item) => item.service === rate.service && item.metric === rate.metric
    );
    const allowance = used ? allowanceOf("paid", used) : undefined;
    if (!used || !allowance) continue;
    const billable = beyond(used, allowance.amount, allowance.per);
    const cost = Math.round((billable / rate.per) * rate.priceMicros);
    totalMicros += cost;
    lines.push({
      service: rate.service,
      metric: rate.metric,
      used: amount(used.total, rate.unit),
      included: `${amount(allowance.amount, rate.unit)} a ${allowance.per}`,
      billable: amount(billable, rate.unit),
      rate: `${formatUsd(rate.priceMicros)} per ${amount(rate.per, rate.unit)}`,
      cost: formatUsd(micros(cost))
    });
  }
  return {
    plan: "paid",
    name: PLAN_NAMES.paid,
    total: formatUsd(micros(totalMicros)),
    base: formatUsd(PRICE_TABLE.paidBaseMicros),
    lines,
    overLimit: []
  };
}

function freeEstimate(usage: ReadonlyArray<Metered>): PlanEstimate {
  const overLimit = usage.flatMap((item): OverLimit[] => {
    const allowance = allowanceOf("free", item);
    if (!allowance) return [];
    const unit =
      PRICE_TABLE.rates.find(
        (rate) => rate.service === item.service && rate.metric === item.metric
      )?.unit ?? item.metric;
    const daysOver = [...item.byDay.values()].filter(
      (day) => day > allowance.amount
    ).length;
    return daysOver === 0
      ? []
      : [
          {
            service: item.service,
            metric: item.metric,
            limit: `${amount(allowance.amount, unit)} a day`,
            daysOver
          }
        ];
  });
  return {
    plan: "free",
    name: PLAN_NAMES.free,
    total: formatUsd(micros(0)),
    base: formatUsd(micros(0)),
    lines: [],
    overLimit
  };
}

function verdictOf(free: PlanEstimate, paid: PlanEstimate): string {
  if (free.overLimit.length === 0) {
    return `This period's usage fits inside the daily limits of ${free.name}, which costs ${free.total}. On ${paid.name} the same usage is estimated at ${paid.total}, of which ${paid.base} is the plan's monthly price.`;
  }
  const worst = free.overLimit.reduce((most, item) =>
    item.daysOver > most.daysOver ? item : most
  );
  const others = free.overLimit.length - 1;
  return `This period's usage went over the daily limits of ${free.name}: ${worst.service} ${worst.metric} passed ${worst.limit} on ${worst.daysOver} day${worst.daysOver === 1 ? "" : "s"}${others > 0 ? `, and ${others} other limit${others === 1 ? " was" : "s were"} passed too` : ""}. On ${free.name}, usage beyond a limit fails; it is not billed. On ${paid.name} the same usage is estimated at ${paid.total}, of which ${paid.base} is the plan's monthly price.`;
}

/** Compares the two plans for one period's usage. */
export function comparePlans(input: PlanInput): PlanComparison {
  const usage = meter(input.records);
  const free = freeEstimate(usage);
  const paid = paidEstimate(usage);
  const priced = new Set(
    PRICE_TABLE.rates.map((rate) => key(rate.service, rate.metric))
  );
  const partial = isOpen(input.period, input.today);
  return {
    month: input.period.start.slice(0, 7),
    partial,
    estimate: true,
    currentPlan: input.currentPlan,
    plans: [free, paid],
    fitsFree: free.overLimit.length === 0,
    verdict: verdictOf(free, paid),
    notPriced: usage
      .filter((item) => !priced.has(key(item.service, item.metric)))
      .map(({ service, metric }) => ({ service, metric })),
    notMeasured: NOT_MEASURED,
    notes: [
      "These are estimates at list price from the account's usage data, not a quote from Cloudflare.",
      ...(partial
        ? [
            `This period is still open: the usage covers part of its ${daysInPeriod(input.period)} days, and the Workers Paid monthly price is counted in full.`
          ]
        : []),
      ...(usage.length === 0
        ? ["There is no usage in this period to compare."]
        : [])
    ],
    priceSource: { checkedOn: PRICE_TABLE.checkedOn, urls: PRICE_TABLE.urls }
  };
}

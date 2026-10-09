/**
 * Included amounts per plan and metric (spec UC-9). A row here is the only
 * source of an allowance: if a metric is not listed, none is shown.
 */

export type Plan = "free" | "paid";

export type Allowance = Readonly<{
  plan: Plan;
  service: string;
  metric: string;
  amount: number;
  /** Free-plan allowances reset daily; paid-plan ones are per billing month. */
  per: "day" | "month";
}>;

export const ALLOWANCE_SOURCE = {
  checkedOn: "2026-10-07",
  urls: [
    "https://developers.cloudflare.com/workers/platform/pricing/",
    "https://developers.cloudflare.com/workers-ai/platform/pricing/",
    "https://developers.cloudflare.com/durable-objects/platform/pricing/",
    "https://developers.cloudflare.com/workflows/reference/pricing/"
  ]
} as const;

export const ALLOWANCES: ReadonlyArray<Allowance> = [
  {
    plan: "free",
    service: "Workers",
    metric: "requests",
    amount: 100_000,
    per: "day"
  },
  {
    plan: "free",
    service: "Workers AI",
    metric: "neurons",
    amount: 10_000,
    per: "day"
  },
  {
    plan: "free",
    service: "Durable Objects",
    metric: "requests",
    amount: 100_000,
    per: "day"
  },
  {
    plan: "free",
    service: "Durable Objects",
    metric: "duration",
    amount: 13_000,
    per: "day"
  },
  {
    plan: "free",
    service: "Durable Objects",
    metric: "rows read",
    amount: 5_000_000,
    per: "day"
  },
  {
    plan: "free",
    service: "Durable Objects",
    metric: "rows written",
    amount: 100_000,
    per: "day"
  },
  {
    plan: "free",
    service: "Workflows",
    metric: "steps",
    amount: 3_000,
    per: "day"
  },
  {
    plan: "paid",
    service: "Workers",
    metric: "requests",
    amount: 10_000_000,
    per: "month"
  },
  {
    plan: "paid",
    service: "Workers AI",
    metric: "neurons",
    amount: 10_000,
    per: "day"
  },
  {
    plan: "paid",
    service: "Durable Objects",
    metric: "requests",
    amount: 1_000_000,
    per: "month"
  },
  {
    plan: "paid",
    service: "Durable Objects",
    metric: "duration",
    amount: 400_000,
    per: "month"
  },
  {
    plan: "paid",
    service: "Durable Objects",
    metric: "rows read",
    amount: 25_000_000_000,
    per: "month"
  },
  {
    plan: "paid",
    service: "Durable Objects",
    metric: "rows written",
    amount: 50_000_000,
    per: "month"
  },
  {
    plan: "paid",
    service: "Workflows",
    metric: "steps",
    amount: 500_000,
    per: "month"
  }
];

export function findAllowance(
  plan: Plan,
  service: string,
  metric: string
): Allowance | undefined {
  return ALLOWANCES.find(
    (allowance) =>
      allowance.plan === plan &&
      allowance.service === service &&
      allowance.metric === metric
  );
}

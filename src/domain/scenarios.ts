import type { Plan } from "./allowances";
import { micros, type Micros } from "./money";
import {
  periodContaining,
  precedingPeriods,
  type BillingPeriod,
  type IsoDate
} from "./periods";
import { ANCHOR_DAY, daily } from "./scenario-builder";
import type { UsageRecord } from "./usage";
import type { BillingState } from "./usage-summary";

/**
 * Fixture accounts for test mode (spec UC-10). Each scenario is a complete
 * account relative to today: the open billing period and three closed ones.
 * The same scenarios back the automated tests and, later, the evals.
 */

export const SCENARIOS = [
  {
    id: "usage-spike",
    title: "Usage spike",
    description:
      "Workers costs many times its usual on the first days of the period."
  },
  {
    id: "lower-no-cause",
    title: "Lower bill, no visible cause",
    description:
      "Costs run a little under usual, with nothing in the data to explain it."
  },
  {
    id: "new-service",
    title: "New product",
    description: "Stream is charged for the first time this period."
  },
  {
    id: "zero-bill",
    title: "No charges",
    description:
      "A free-plan account with real usage, no costs and no invoices."
  }
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]["id"];

export type ScenarioInvoice = Readonly<{
  periodStart: IsoDate;
  periodEnd: IsoDate;
  amountMicros: Micros;
}>;

export type ScenarioData = Readonly<{
  anchorDay: number;
  plan: Plan;
  billing: BillingState;
  records: ReadonlyArray<UsageRecord>;
  invoices: ReadonlyArray<ScenarioInvoice>;
}>;

const CLOSED_PERIODS = 3;

export function isScenarioId(value: unknown): value is ScenarioId {
  return SCENARIOS.some((scenario) => scenario.id === value);
}

type PeriodRecords = (
  period: BillingPeriod,
  isCurrent: boolean
) => UsageRecord[];

const steady: PeriodRecords = (period) => [
  ...daily("Workers", period, 4),
  ...daily("R2", period, 1, {
    metric: "storage",
    unit: "GB-months",
    unitsPerUsd: 66
  })
];

const recordsFor: Record<ScenarioId, PeriodRecords> = {
  "usage-spike": (period, isCurrent) =>
    isCurrent
      ? [
          ...daily("Workers", period, 4, { overrides: { 1: 90, 2: 110 } }),
          ...daily("R2", period, 1, {
            metric: "storage",
            unit: "GB-months",
            unitsPerUsd: 66
          })
        ]
      : steady(period, false),
  "lower-no-cause": (period, isCurrent) =>
    isCurrent
      ? [
          ...daily("Workers", period, 3.6),
          ...daily("R2", period, 0.9, {
            metric: "storage",
            unit: "GB-months",
            unitsPerUsd: 66
          })
        ]
      : steady(period, false),
  "new-service": (period, isCurrent) =>
    isCurrent
      ? [
          ...steady(period, true),
          ...daily("Stream", period, 2, {
            metric: "minutes delivered",
            unit: "minutes",
            unitsPerUsd: 1_000
          })
        ]
      : steady(period, false),
  "zero-bill": (period) =>
    [
      ...daily("Workers AI", period, 0, { metric: "neurons", unit: "neurons" }),
      ...daily("Workers", period, 0),
      ...daily("Durable Objects", period, 0)
    ].map((record) => ({
      ...record,
      quantity: FREE_DAILY_QUANTITY[record.service] ?? 0,
      costMicros: null
    }))
};

const FREE_DAILY_QUANTITY: Readonly<Record<string, number>> = {
  "Workers AI": 300,
  Workers: 150,
  "Durable Objects": 60
};

/** Builds a scenario's account as of today. No record is dated after today. */
export function buildScenario(id: ScenarioId, today: IsoDate): ScenarioData {
  const current = periodContaining(today, ANCHOR_DAY);
  const closed = precedingPeriods(current, ANCHOR_DAY, CLOSED_PERIODS);
  const build = recordsFor[id];
  const free = id === "zero-bill";
  const closedRecords = closed.map((period) => build(period, false));
  return {
    anchorDay: ANCHOR_DAY,
    plan: free ? "free" : "paid",
    billing: free ? { status: "none" } : { status: "costed" },
    records: [
      ...build(current, true).filter((record) => record.date <= today),
      ...closedRecords.flat()
    ],
    invoices: free
      ? []
      : closed.map((period, index) => ({
          periodStart: period.start,
          periodEnd: period.end,
          amountMicros: micros(
            (closedRecords[index] ?? []).reduce(
              (total, record) => total + (record.costMicros ?? 0),
              0
            )
          )
        }))
  };
}

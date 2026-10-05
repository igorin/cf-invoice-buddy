import { describeOwnUsage } from "../db/self-usage-store";
import {
  isPeriodSynced,
  readBilling,
  readInvoiceAmount,
  readUsage,
  type Dataset
} from "../db/usage-store";
import { explainBill, type Explanation } from "../domain/explain";
import {
  addDays,
  isoDate,
  periodContaining,
  precedingPeriods,
  type BillingPeriod,
  type IsoDate
} from "../domain/periods";
import type { ScenarioId } from "../domain/scenarios";

/**
 * Explains a month's bill from stored usage (spec UC-1, UC-2).
 *
 * The baseline is the month the owner names, fetched on demand through
 * `ensurePeriod`. With no month named it is whatever earlier months are
 * already stored, up to three; nothing is fetched to make one up.
 */

type Sql = Parameters<typeof readUsage>[0];

export type ExplainRequest = Readonly<{
  month?: string;
  baselineMonth?: string;
}>;

/** A bill explanation, with the dataset it came from (rule G-9). */
export type ExplanationView = Explanation &
  Readonly<{
    dataset: Dataset;
    scenario: ScenarioId | null;
    /** The assistant's own metered model cost in the period. Live data only. */
    assistantOwnUsage: string | null;
  }>;

export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DEFAULT_BASELINE_PERIODS = 3;

export type ExplainContext = Readonly<{
  sql: Sql;
  dataset: Dataset;
  scenario: ScenarioId | null;
  today: IsoDate;
  anchorDay: number;
  /** Makes sure a period's usage is stored, fetching it if it can be. */
  ensurePeriod: (period: BillingPeriod) => Promise<void>;
}>;

function periodFor(
  month: string | undefined,
  context: ExplainContext
): BillingPeriod {
  if (month === undefined) {
    return periodContaining(context.today, context.anchorDay);
  }
  if (!MONTH_PATTERN.test(month)) throw new Error("Month must be YYYY-MM");
  const period = periodContaining(isoDate(`${month}-15`), context.anchorDay);
  if (period.start > context.today) {
    throw new Error("That month has not started yet");
  }
  return period;
}

export async function explainStoredBill(
  request: ExplainRequest,
  context: ExplainContext
): Promise<ExplanationView> {
  const { sql, dataset, today } = context;
  const period = periodFor(request.month, context);
  await context.ensurePeriod(period);

  const named = request.baselineMonth
    ? periodFor(request.baselineMonth, context)
    : null;
  if (named) await context.ensurePeriod(named);
  const baselinePeriods = named
    ? [named]
    : precedingPeriods(
        period,
        context.anchorDay,
        DEFAULT_BASELINE_PERIODS
      ).filter((candidate) => isPeriodSynced(sql, dataset, candidate.start));
  const recordsOf = (p: BillingPeriod) =>
    readUsage(sql, dataset, p.start, addDays(p.end, -1));

  const explanation = explainBill({
    period,
    today,
    current: recordsOf(period).filter((record) => record.date <= today),
    baseline: {
      chosenByOwner: named !== null,
      periods: baselinePeriods.map((p) => ({
        period: p,
        records: recordsOf(p)
      }))
    },
    invoiceMicros: readInvoiceAmount(sql, dataset, period.start),
    billing: readBilling(sql, dataset)?.billing ?? {
      status: "unavailable",
      reason: "billing data has not been read yet"
    }
  });
  return {
    ...explanation,
    dataset,
    scenario: context.scenario,
    // Never mixed into test-mode answers: the meter is real data (G-9).
    assistantOwnUsage: dataset === "live" ? describeOwnUsage(sql, period) : null
  };
}

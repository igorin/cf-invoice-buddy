import { readBilling, readUsage, type Dataset } from "../db/usage-store";
import {
  addDays,
  isoDate,
  periodContaining,
  type BillingPeriod,
  type IsoDate
} from "../domain/periods";
import { comparePlans, type PlanComparison } from "../domain/plans";
import type { ScenarioId } from "../domain/scenarios";
import { MONTH_PATTERN } from "./explain-service";

/** Plan comparison (spec UC-7) from the usage stored for a period. */

type Sql = DurableObjectStorage["sql"];

export type PlanComparisonView = PlanComparison &
  Readonly<{ dataset: Dataset; scenario: ScenarioId | null }>;

export type PlanContext = Readonly<{
  sql: Sql;
  dataset: Dataset;
  scenario: ScenarioId | null;
  today: IsoDate;
  anchorDay: number;
  /** Makes sure a period's usage is stored, fetching it if it can be. */
  ensurePeriod: (period: BillingPeriod) => Promise<void>;
}>;

/**
 * Compares the plans for the month named, or the current one. A value that
 * is not a month, or a month that has not started, means the current one.
 */
export async function comparePlansFor(
  month: string | undefined,
  context: PlanContext
): Promise<PlanComparisonView> {
  const { sql, dataset, today } = context;
  const current = periodContaining(today, context.anchorDay);
  const named =
    month !== undefined && MONTH_PATTERN.test(month)
      ? periodContaining(isoDate(`${month}-15`), context.anchorDay)
      : current;
  const period = named.start > today ? current : named;
  await context.ensurePeriod(period);
  const records = readUsage(
    sql,
    dataset,
    period.start,
    addDays(period.end, -1)
  ).filter((record) => record.date <= today);
  return {
    ...comparePlans({
      period,
      today,
      records,
      currentPlan: readBilling(sql, dataset)?.plan ?? "free"
    }),
    dataset,
    scenario: context.scenario
  };
}

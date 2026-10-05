import {
  clearDataset,
  markPeriodSynced,
  replaceUsage,
  saveBilling,
  saveInvoice
} from "../db/usage-store";
import {
  periodContaining,
  precedingPeriods,
  type IsoDate
} from "../domain/periods";
import {
  buildScenario,
  isScenarioId,
  type ScenarioId
} from "../domain/scenarios";

type Sql = Parameters<typeof replaceUsage>[0];

const CLOSED_PERIODS = 3;

/**
 * Loads a test scenario into the "test" dataset, replacing whatever scenario
 * was there (spec UC-10). The live dataset is never touched.
 */
export function loadScenario(
  sql: Sql,
  scenario: unknown,
  today: IsoDate
): Readonly<{ dataset: "test"; scenario: ScenarioId }> {
  if (!isScenarioId(scenario)) throw new Error("Unknown test scenario");
  const data = buildScenario(scenario, today);
  const at = new Date().toISOString();
  clearDataset(sql, "test");
  const first = data.records.map((record) => record.date).sort()[0] ?? today;
  replaceUsage(sql, "test", [], first, today, data.records);
  saveBilling(sql, "test", data.billing, data.plan, at);
  const current = periodContaining(today, data.anchorDay);
  const periods = [
    current,
    ...precedingPeriods(current, data.anchorDay, CLOSED_PERIODS)
  ];
  for (const period of periods) markPeriodSynced(sql, "test", period.start, at);
  for (const invoice of data.invoices) saveInvoice(sql, "test", invoice);
  return { dataset: "test", scenario };
}

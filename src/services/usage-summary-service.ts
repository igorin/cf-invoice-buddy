import type { DataMode, UsageSummaryView } from "../agent-state";
import { readBilling, readSourceStatus, readUsage } from "../db/usage-store";
import { ALLOWANCE_SOURCE } from "../domain/allowances";
import { periodContaining, type IsoDate } from "../domain/periods";
import { buildUsageSummary } from "../domain/usage-summary";

type Sql = DurableObjectStorage["sql"];

/** Builds the usage summary (UC-9) from what is stored for the data mode. */
export function readUsageSummaryView(
  sql: Sql,
  mode: DataMode,
  today: IsoDate,
  anchorDay: number
): UsageSummaryView {
  const period = periodContaining(today, anchorDay);
  const stored = readBilling(sql, mode.dataset);
  const summary = buildUsageSummary({
    records: readUsage(sql, mode.dataset, period.start, today),
    period,
    today,
    plan: stored?.plan ?? "free",
    sources: readSourceStatus(sql, mode.dataset),
    billing: stored?.billing ?? {
      status: "unavailable",
      reason: "billing data has not been read yet"
    }
  });
  return {
    ...summary,
    dataset: mode.dataset,
    scenario: mode.dataset === "test" ? mode.scenario : null,
    plan: stored?.plan ?? "free",
    lastSyncAt: mode.dataset === "live" ? (stored?.syncedAt ?? null) : null,
    allowanceSource: ALLOWANCE_SOURCE
  };
}

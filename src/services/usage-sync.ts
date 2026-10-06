import {
  markPeriodSynced,
  replaceUsage,
  saveBilling,
  saveSourceStatus
} from "../db/usage-store";
import { addDays, type BillingPeriod, type IsoDate } from "../domain/periods";
import type { BillingSource, UsageSource } from "../ports/sources";

/**
 * Pulls live usage into storage. Only the "live" dataset is ever written
 * here; test data is loaded by the scenario service (spec UC-10).
 */

type Sql = Parameters<typeof replaceUsage>[0];

const readableServices = (
  sources: Awaited<ReturnType<UsageSource["fetchUsage"]>>["sources"]
): string[] => sources.filter((s) => s.available).map((s) => s.service);

/** Syncs the current period's usage and the billing status. Returns the sync time. */
export async function syncCurrentPeriod(
  sql: Sql,
  usageSource: UsageSource,
  billingSource: BillingSource,
  period: BillingPeriod,
  today: IsoDate
): Promise<string> {
  const [usage, billing] = await Promise.all([
    usageSource.fetchUsage(period.start, today),
    billingSource.fetchBilling()
  ]);
  const at = new Date().toISOString();
  // Rows of a product that failed are left as they were; its status is what
  // keeps them out of the summary.
  replaceUsage(
    sql,
    "live",
    readableServices(usage.sources),
    period.start,
    today,
    usage.records
  );
  markPeriodSynced(sql, "live", period.start, at);
  saveSourceStatus(sql, "live", usage.sources, at);
  saveBilling(sql, "live", billing.billing, billing.plan, at);
  return at;
}

/** Fetches one closed month on demand, for use as a baseline (UC-1). */
export async function fetchClosedMonth(
  sql: Sql,
  usageSource: UsageSource,
  period: BillingPeriod
): Promise<void> {
  const last = addDays(period.end, -1);
  const usage = await usageSource.fetchUsage(period.start, last);
  replaceUsage(
    sql,
    "live",
    readableServices(usage.sources),
    period.start,
    last,
    usage.records
  );
  // A month with a failed product is fetched again next time it is asked for.
  if (usage.sources.every((source) => source.available)) {
    markPeriodSynced(sql, "live", period.start, new Date().toISOString());
  }
}

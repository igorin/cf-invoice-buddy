import type { Plan } from "../domain/allowances";
import { micros, type Micros } from "../domain/money";
import { isoDate, type IsoDate } from "../domain/periods";
import type { UsageRecord } from "../domain/usage";
import type { BillingState, SourceStatus } from "../domain/usage-summary";

/**
 * Stored usage. Every read and write names its dataset, "live" or "test";
 * there is no default, so fixture data cannot leak into live answers or the
 * other way round (spec UC-10, G-9).
 */

export type Dataset = "live" | "test";

type Sql = {
  exec(
    query: string,
    ...bindings: unknown[]
  ): Iterable<Record<string, unknown>>;
};

export type StoredBilling = Readonly<{
  billing: BillingState;
  plan: Plan;
  syncedAt: string;
}>;

/** Replaces the stored rows of the given services in a date range. */
export function replaceUsage(
  sql: Sql,
  dataset: Dataset,
  services: ReadonlyArray<string>,
  from: IsoDate,
  to: IsoDate,
  records: ReadonlyArray<UsageRecord>
): void {
  for (const service of services) {
    sql.exec(
      "DELETE FROM usage_records WHERE dataset = ? AND service = ? AND date >= ? AND date <= ?",
      dataset,
      service,
      from,
      to
    );
  }
  for (const record of records) {
    sql.exec(
      `INSERT OR REPLACE INTO usage_records
        (dataset, date, service, metric, zone, quantity, unit, billable_quantity, cost_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      dataset,
      record.date,
      record.service,
      record.metric,
      record.zone ?? "",
      record.quantity,
      record.unit,
      record.billableQuantity,
      record.costMicros
    );
  }
}

export function readUsage(
  sql: Sql,
  dataset: Dataset,
  from: IsoDate,
  to: IsoDate
): UsageRecord[] {
  const rows = sql.exec(
    `SELECT date, service, metric, zone, quantity, unit, billable_quantity, cost_micros
     FROM usage_records WHERE dataset = ? AND date >= ? AND date <= ?
     ORDER BY date, service, metric`,
    dataset,
    from,
    to
  );
  return [...rows].map((row) => ({
    date: isoDate(String(row.date)),
    service: String(row.service),
    metric: String(row.metric),
    zone: row.zone ? String(row.zone) : null,
    quantity: Number(row.quantity),
    unit: String(row.unit),
    billableQuantity:
      row.billable_quantity === null ? null : Number(row.billable_quantity),
    costMicros:
      row.cost_micros === null ? null : micros(Number(row.cost_micros))
  }));
}

export function saveSourceStatus(
  sql: Sql,
  dataset: Dataset,
  sources: ReadonlyArray<SourceStatus>,
  at: string
): void {
  sql.exec("DELETE FROM usage_source_status WHERE dataset = ?", dataset);
  for (const source of sources) {
    sql.exec(
      `INSERT INTO usage_source_status (dataset, service, available, reason, checked_at)
       VALUES (?, ?, ?, ?, ?)`,
      dataset,
      source.service,
      source.available ? 1 : 0,
      source.reason ?? null,
      at
    );
  }
}

export function readSourceStatus(sql: Sql, dataset: Dataset): SourceStatus[] {
  const rows = sql.exec(
    "SELECT service, available, reason FROM usage_source_status WHERE dataset = ? ORDER BY service",
    dataset
  );
  return [...rows].map((row) =>
    row.available === 1
      ? { service: String(row.service), available: true }
      : {
          service: String(row.service),
          available: false,
          reason: String(row.reason ?? "unknown")
        }
  );
}

export function saveBilling(
  sql: Sql,
  dataset: Dataset,
  billing: BillingState,
  plan: Plan,
  at: string
): void {
  sql.exec(
    `INSERT OR REPLACE INTO account_billing (dataset, status, reason, plan, synced_at)
     VALUES (?, ?, ?, ?, ?)`,
    dataset,
    billing.status,
    billing.status === "unavailable" ? billing.reason : null,
    plan,
    at
  );
}

export function readBilling(sql: Sql, dataset: Dataset): StoredBilling | null {
  const [row] = [
    ...sql.exec(
      "SELECT status, reason, plan, synced_at FROM account_billing WHERE dataset = ?",
      dataset
    )
  ];
  if (!row) return null;
  const billing: BillingState =
    row.status === "none"
      ? { status: "none" }
      : row.status === "costed"
        ? { status: "costed" }
        : { status: "unavailable", reason: String(row.reason ?? "unknown") };
  return {
    billing,
    plan: row.plan === "paid" ? "paid" : "free",
    syncedAt: String(row.synced_at)
  };
}

/** Removes every stored row of a dataset. Used when a test scenario is loaded. */
export function clearDataset(sql: Sql, dataset: Dataset): void {
  for (const table of [
    "usage_records",
    "usage_source_status",
    "account_billing",
    "usage_periods",
    "invoices"
  ]) {
    sql.exec(`DELETE FROM ${table} WHERE dataset = ?`, dataset);
  }
}

/** Records that a billing period's usage has been fetched for a dataset. */
export function markPeriodSynced(
  sql: Sql,
  dataset: Dataset,
  periodStart: IsoDate,
  at: string
): void {
  sql.exec(
    "INSERT OR REPLACE INTO usage_periods (dataset, period_start, synced_at) VALUES (?, ?, ?)",
    dataset,
    periodStart,
    at
  );
}

export function isPeriodSynced(
  sql: Sql,
  dataset: Dataset,
  periodStart: IsoDate
): boolean {
  const rows = sql.exec(
    "SELECT 1 AS found FROM usage_periods WHERE dataset = ? AND period_start = ?",
    dataset,
    periodStart
  );
  return [...rows].length > 0;
}

export function saveInvoice(
  sql: Sql,
  dataset: Dataset,
  invoice: Readonly<{
    periodStart: IsoDate;
    periodEnd: IsoDate;
    amountMicros: Micros;
  }>
): void {
  sql.exec(
    `INSERT OR REPLACE INTO invoices (dataset, period_start, period_end, amount_micros)
     VALUES (?, ?, ?, ?)`,
    dataset,
    invoice.periodStart,
    invoice.periodEnd,
    invoice.amountMicros
  );
}

export function readInvoiceAmount(
  sql: Sql,
  dataset: Dataset,
  periodStart: IsoDate
): Micros | null {
  const [row] = [
    ...sql.exec(
      "SELECT amount_micros FROM invoices WHERE dataset = ? AND period_start = ?",
      dataset,
      periodStart
    )
  ];
  return row ? micros(Number(row.amount_micros)) : null;
}

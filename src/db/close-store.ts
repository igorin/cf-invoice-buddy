import type { CloseState, CloseSummary } from "../domain/close";
import type { UsageRecord } from "../domain/usage";
import type { Dataset } from "./usage-store";

/**
 * Invoice closes in the agent's SQLite (spec section 4, UC-6). A period has
 * one row per dataset. A closed row is never changed again: every update
 * below leaves a row alone once its state is `closed`.
 */

type Sql = DurableObjectStorage["sql"];

export type StoredClose = Readonly<{
  dataset: Dataset;
  periodStart: string;
  periodEnd: string;
  workflowId: string;
  state: CloseState;
  snapshot: ReadonlyArray<UsageRecord> | null;
  summary: Partial<CloseSummary> | null;
  approvedAt: string | null;
  decidedReason: string | null;
  startedAt: string;
  updatedAt: string;
  closedAt: string | null;
}>;

const COLUMNS = `dataset, period_start, period_end, workflow_id, state,
  snapshot_json, summary_json, approved_at, decided_reason, started_at,
  updated_at, closed_at`;

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

const parsed = <T>(value: unknown): T | null =>
  value === null || value === undefined
    ? null
    : (JSON.parse(String(value)) as T);

function fromRow(row: Record<string, unknown>): StoredClose {
  return {
    dataset: row.dataset as Dataset,
    periodStart: String(row.period_start),
    periodEnd: String(row.period_end),
    workflowId: String(row.workflow_id),
    state: row.state as CloseState,
    snapshot: parsed<UsageRecord[]>(row.snapshot_json),
    summary: parsed<Partial<CloseSummary>>(row.summary_json),
    approvedAt: text(row.approved_at),
    decidedReason: text(row.decided_reason),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    closedAt: text(row.closed_at)
  };
}

const one = (rows: Iterable<Record<string, unknown>>): StoredClose | null => {
  const [row] = [...rows];
  return row ? fromRow(row) : null;
};

export function readClose(
  sql: Sql,
  dataset: Dataset,
  periodStart: string
): StoredClose | null {
  return one(
    sql.exec(
      `SELECT ${COLUMNS} FROM invoice_closes
       WHERE dataset = ? AND period_start = ?`,
      dataset,
      periodStart
    )
  );
}

/** The close a workflow run belongs to; null once a later run replaced it. */
export function readCloseByWorkflow(
  sql: Sql,
  workflowId: string
): StoredClose | null {
  return one(
    sql.exec(
      `SELECT ${COLUMNS} FROM invoice_closes WHERE workflow_id = ?`,
      workflowId
    )
  );
}

export function listCloses(sql: Sql, dataset: Dataset): StoredClose[] {
  return [
    ...sql.exec(
      `SELECT ${COLUMNS} FROM invoice_closes WHERE dataset = ?
       ORDER BY period_start DESC`,
      dataset
    )
  ].map(fromRow);
}

/**
 * Starts a close, or starts one again after it was rejected, expired or
 * failed. The earlier attempt's snapshot and summary are cleared.
 */
export function startClose(
  sql: Sql,
  close: Pick<
    StoredClose,
    "dataset" | "periodStart" | "periodEnd" | "workflowId"
  >,
  at: string
): void {
  sql.exec(
    `INSERT INTO invoice_closes
      (dataset, period_start, period_end, workflow_id, state, started_at, updated_at)
     VALUES (?, ?, ?, ?, 'snapshotted', ?, ?)
     ON CONFLICT (dataset, period_start) DO UPDATE SET
       workflow_id = excluded.workflow_id, state = 'snapshotted',
       snapshot_json = NULL, summary_json = NULL, approved_at = NULL,
       decided_reason = NULL, started_at = excluded.started_at,
       updated_at = excluded.updated_at
     WHERE invoice_closes.state != 'closed'`,
    close.dataset,
    close.periodStart,
    close.periodEnd,
    close.workflowId,
    at,
    at
  );
}

/** Freezes the period's usage. Keeps the first snapshot if called again. */
export function saveSnapshot(
  sql: Sql,
  workflowId: string,
  records: ReadonlyArray<UsageRecord>,
  at: string
): void {
  sql.exec(
    `UPDATE invoice_closes SET snapshot_json = ?, updated_at = ?
     WHERE workflow_id = ? AND snapshot_json IS NULL AND state != 'closed'`,
    JSON.stringify(records),
    at,
    workflowId
  );
}

export function saveSummary(
  sql: Sql,
  workflowId: string,
  summary: Partial<CloseSummary>,
  at: string
): void {
  sql.exec(
    `UPDATE invoice_closes SET summary_json = ?, updated_at = ?
     WHERE workflow_id = ? AND state != 'closed'`,
    JSON.stringify(summary),
    at,
    workflowId
  );
}

/** Moves a close to another state, only from one of the states given. */
export function moveClose(
  sql: Sql,
  workflowId: string,
  change: Readonly<{
    from: ReadonlyArray<CloseState>;
    to: CloseState;
    at: string;
    reason?: string | null;
    approved?: boolean;
  }>
): void {
  const from = change.from.filter((state) => state !== "closed");
  if (from.length === 0) return;
  sql.exec(
    `UPDATE invoice_closes
     SET state = ?, updated_at = ?,
       decided_reason = COALESCE(?, decided_reason),
       approved_at = CASE WHEN ? = 1 THEN ? ELSE approved_at END,
       closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END
     WHERE workflow_id = ? AND state IN (${from.map(() => "?").join(", ")})`,
    change.to,
    change.at,
    change.reason ?? null,
    change.approved ? 1 : 0,
    change.at,
    change.to,
    change.at,
    workflowId,
    ...from
  );
}

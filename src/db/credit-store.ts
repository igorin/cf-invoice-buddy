import type {
  CreditBasis,
  CreditEvidence,
  CreditState
} from "../domain/credit-draft";
import type { Dataset } from "./usage-store";

/** Credit request drafts in the agent's SQLite (spec section 4, UC-3, UC-4). */

type Sql = DurableObjectStorage["sql"];

export type StoredCredit = Readonly<{
  id: string;
  dataset: Dataset;
  periodStart: string;
  service: string;
  amount: string | null;
  basis: CreditBasis;
  ownerReason: string;
  draft: string;
  evidence: CreditEvidence;
  state: CreditState;
  /** What the owner said was credited. The owner's word, never checked. */
  reportedAmount: string | null;
  reportedNote: string | null;
  createdAt: string;
  updatedAt: string;
}>;

const COLUMNS = `id, dataset, period_start, service, amount, basis,
  owner_reason, draft, evidence_json, state, reported_amount, reported_note,
  created_at, updated_at`;

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function fromRow(row: Record<string, unknown>): StoredCredit {
  return {
    id: String(row.id),
    dataset: row.dataset as Dataset,
    periodStart: String(row.period_start),
    service: String(row.service),
    amount: text(row.amount),
    basis: row.basis as CreditBasis,
    ownerReason: String(row.owner_reason),
    draft: String(row.draft),
    evidence: JSON.parse(String(row.evidence_json)) as CreditEvidence,
    state: row.state as CreditState,
    reportedAmount: text(row.reported_amount),
    reportedNote: text(row.reported_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

export function insertCredit(sql: Sql, credit: StoredCredit): void {
  sql.exec(
    `INSERT INTO credit_requests (${COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    credit.id,
    credit.dataset,
    credit.periodStart,
    credit.service,
    credit.amount,
    credit.basis,
    credit.ownerReason,
    credit.draft,
    JSON.stringify(credit.evidence),
    credit.state,
    credit.reportedAmount,
    credit.reportedNote,
    credit.createdAt,
    credit.updatedAt
  );
}

/** The draft in force for a period and product: the newest not replaced. */
export function findCurrentCredit(
  sql: Sql,
  dataset: Dataset,
  periodStart: string,
  service: string
): StoredCredit | null {
  const rows = [
    ...sql.exec(
      `SELECT ${COLUMNS} FROM credit_requests
       WHERE dataset = ? AND period_start = ? AND service = ?
         AND state != 'superseded'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      dataset,
      periodStart,
      service
    )
  ];
  return rows[0] ? fromRow(rows[0]) : null;
}

export function readCredit(
  sql: Sql,
  dataset: Dataset,
  id: string
): StoredCredit | null {
  const rows = [
    ...sql.exec(
      `SELECT ${COLUMNS} FROM credit_requests WHERE dataset = ? AND id = ?`,
      dataset,
      id
    )
  ];
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Every draft of a dataset, newest first. Replaced drafts are kept. */
export function listCredits(sql: Sql, dataset: Dataset): StoredCredit[] {
  return [
    ...sql.exec(
      `SELECT ${COLUMNS} FROM credit_requests WHERE dataset = ?
       ORDER BY created_at DESC, id DESC`,
      dataset
    )
  ].map(fromRow);
}

/** Changes a draft's state, with what the owner reported if anything. */
export function updateCreditState(
  sql: Sql,
  id: string,
  change: Readonly<{
    state: CreditState;
    reportedAmount?: string | null;
    reportedNote?: string | null;
    at: string;
  }>
): void {
  sql.exec(
    `UPDATE credit_requests
     SET state = ?, reported_amount = COALESCE(?, reported_amount),
       reported_note = COALESCE(?, reported_note), updated_at = ?
     WHERE id = ?`,
    change.state,
    change.reportedAmount ?? null,
    change.reportedNote ?? null,
    change.at,
    id
  );
}

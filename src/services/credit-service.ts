import {
  findCurrentCredit,
  insertCredit,
  listCredits,
  readCredit,
  updateCreditState,
  type StoredCredit
} from "../db/credit-store";
import type { Dataset } from "../db/usage-store";
import {
  OWNER_OUTCOMES,
  SUBMISSION,
  cleanReason,
  describeState,
  gatherCreditEvidence,
  isOwnerOutcome,
  renderCreditDraft
} from "../domain/credit-draft";
import type { ExplanationView } from "./explain-service";

/**
 * Credit request drafts (spec UC-3, UC-4): write a draft from the account's
 * stored data, keep it, list it later, and record what the owner says became
 * of it. Nothing here contacts Cloudflare.
 */

type Sql = DurableObjectStorage["sql"];

export type CreditView = StoredCredit &
  Readonly<{ month: string; stateInWords: string; testData: boolean }>;

export type DraftRequest = Readonly<{
  month?: string;
  service: string;
  ownerReason: string;
  replaceExisting?: boolean;
}>;

export type DraftResult =
  | Readonly<{
      /** existing: a draft was already there and was left as it is. */
      status: "drafted" | "replaced" | "existing";
      request: CreditView;
      submission: typeof SUBMISSION;
    }>
  | Readonly<{
      status: "unknown_service";
      month: string;
      services: ReadonlyArray<string>;
    }>;

export type OutcomeRequest = Readonly<{
  id: string;
  outcome: unknown;
  amount?: string | null;
  note?: string | null;
}>;

export type OutcomeResult =
  | Readonly<{ status: "recorded"; request: CreditView }>
  | Readonly<{ status: "not_found" | "replaced" | "invalid_outcome" }>;

const MAX_NOTE_CHARS = 500;

function view(credit: StoredCredit): CreditView {
  return {
    ...credit,
    month: credit.periodStart.slice(0, 7),
    stateInWords: describeState(credit.state),
    testData: credit.dataset === "test"
  };
}

/** Writes and stores a draft for one product in the explained period. */
export function draftCredit(
  sql: Sql,
  explanation: ExplanationView,
  request: DraftRequest,
  now: Date
): DraftResult {
  const testData = explanation.dataset === "test";
  const evidence = gatherCreditEvidence(explanation, request.service, testData);
  if (evidence === null) {
    return {
      status: "unknown_service",
      month: explanation.period.start.slice(0, 7),
      services: explanation.services.map((line) => line.service)
    };
  }
  const existing = findCurrentCredit(
    sql,
    explanation.dataset,
    evidence.period.start,
    evidence.service
  );
  if (existing !== null && request.replaceExisting !== true) {
    return {
      status: "existing",
      request: view(existing),
      submission: SUBMISSION
    };
  }
  const at = now.toISOString();
  if (existing !== null) {
    updateCreditState(sql, existing.id, { state: "superseded", at });
  }
  const credit: StoredCredit = {
    id: `cr_${crypto.randomUUID().slice(0, 8)}`,
    dataset: explanation.dataset,
    periodStart: evidence.period.start,
    service: evidence.service,
    amount: evidence.amount,
    basis: evidence.basis,
    ownerReason: cleanReason(request.ownerReason),
    draft: renderCreditDraft(evidence, request.ownerReason),
    evidence,
    state: "drafted",
    reportedAmount: null,
    reportedNote: null,
    createdAt: at,
    updatedAt: at
  };
  insertCredit(sql, credit);
  return {
    status: existing === null ? "drafted" : "replaced",
    request: view(credit),
    submission: SUBMISSION
  };
}

export function listCreditViews(sql: Sql, dataset: Dataset): CreditView[] {
  return listCredits(sql, dataset).map(view);
}

/** Stores what the owner says happened to a request. It is never verified. */
export function reportCreditOutcome(
  sql: Sql,
  dataset: Dataset,
  request: OutcomeRequest,
  now: Date
): OutcomeResult {
  if (!isOwnerOutcome(request.outcome)) return { status: "invalid_outcome" };
  const credit = readCredit(sql, dataset, request.id.trim());
  if (credit === null) return { status: "not_found" };
  if (credit.state === "superseded") return { status: "replaced" };
  const clean = (value: string | null | undefined): string | null => {
    const trimmed = value?.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
    return trimmed ? trimmed : null;
  };
  updateCreditState(sql, credit.id, {
    state: OWNER_OUTCOMES[request.outcome],
    reportedAmount: clean(request.amount),
    reportedNote: clean(request.note),
    at: now.toISOString()
  });
  const updated = readCredit(sql, dataset, credit.id);
  // The row was read a moment ago in the same synchronous storage.
  return { status: "recorded", request: view(updated ?? credit) };
}

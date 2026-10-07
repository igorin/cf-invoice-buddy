import { totalCost } from "./breakdown";
import { explainBill, type ExplainInput, type Explanation } from "./explain";
import { formatUsd, micros } from "./money";
import { isOpen, type BillingPeriod, type IsoDate } from "./periods";
import { reconcile } from "./reconcile";
import type { UsageRecord } from "./usage";

/**
 * The monthly invoice close (spec UC-6). A close freezes a finished period's
 * usage, totals it per product, reconciles it with the invoice, checks it
 * for anomalies and waits for the owner. Pure code: no Cloudflare imports.
 */

export const CLOSE_STATES = [
  "snapshotted",
  "awaiting_approval",
  "closed",
  "rejected",
  "expired",
  "failed"
] as const;

export type CloseState = (typeof CLOSE_STATES)[number];

/** A close that is still running. A period has at most one. */
export const isInProgress = (state: CloseState): boolean =>
  state === "snapshotted" || state === "awaiting_approval";

export type StartCheck =
  | "ok"
  /** The period has not ended; its figures can still change. */
  | "open_period"
  | "already_closed"
  | "in_progress";

/** Whether a close may start. A rejected, expired or failed one may be redone. */
export function checkCloseStart(
  period: BillingPeriod,
  today: IsoDate,
  existing: CloseState | null
): StartCheck {
  if (isOpen(period, today)) return "open_period";
  if (existing === "closed") return "already_closed";
  if (existing !== null && isInProgress(existing)) return "in_progress";
  return "ok";
}

export type CloseSummary = Readonly<{
  month: string;
  total: string;
  lineItems: ReadonlyArray<Readonly<{ service: string; amount: string }>>;
  reconciliation: Readonly<{
    status: "no_invoice" | "matched" | "variance";
    /** Present when there is an invoice for the period. */
    invoice: string | null;
    statement: string;
  }>;
  findings: Explanation["findings"];
  unexplained: string | null;
  notes: ReadonlyArray<string>;
  usageRecords: number;
}>;

export type CloseInput = Readonly<{
  period: BillingPeriod;
  snapshot: ReadonlyArray<UsageRecord>;
  baseline: ExplainInput["baseline"];
  invoiceMicros: ExplainInput["invoiceMicros"];
  billing: ExplainInput["billing"];
}>;

function reconciliationOf(
  input: CloseInput,
  total: string
): CloseSummary["reconciliation"] {
  const result = reconcile(
    totalCost(input.snapshot).costMicros,
    input.invoiceMicros
  );
  if (result.status === "no_invoice" || input.invoiceMicros === null) {
    return {
      status: "no_invoice",
      invoice: null,
      statement:
        "There is no invoice for this period in the account's data, so the usage total could not be reconciled."
    };
  }
  const invoice = formatUsd(input.invoiceMicros);
  if (result.status === "matched") {
    return {
      status: "matched",
      invoice,
      statement: `The invoice (${invoice}) matches the usage total (${total}).`
    };
  }
  const gap = formatUsd(micros(Math.abs(result.varianceMicros)));
  return {
    status: "variance",
    invoice,
    statement: `The invoice (${invoice}) is ${gap} ${result.varianceMicros > 0 ? "more" : "less"} than the usage total (${total}).`
  };
}

/**
 * Totals a frozen period and checks it. Uses the same breakdown and the same
 * detectors as a bill explanation, on the snapshot instead of live usage.
 */
export function summariseClose(input: CloseInput): CloseSummary {
  const explanation = explainBill({
    period: input.period,
    // The day after the period: the period is finished, never part-way.
    today: input.period.end,
    current: input.snapshot,
    baseline: input.baseline,
    invoiceMicros: input.invoiceMicros,
    billing: input.billing
  });
  return {
    month: input.period.start.slice(0, 7),
    total: explanation.total,
    lineItems: explanation.services.map((line) => ({
      service: line.service,
      amount: line.current
    })),
    reconciliation: reconciliationOf(input, explanation.total),
    findings: explanation.findings,
    unexplained: explanation.unexplained,
    notes: explanation.notes,
    usageRecords: input.snapshot.length
  };
}

/** A state in words. */
export function describeCloseState(state: CloseState): string {
  switch (state) {
    case "snapshotted":
      return "In progress: the period's usage is frozen and is being totalled.";
    case "awaiting_approval":
      return "Waiting for the owner to approve or reject. The period is still open.";
    case "closed":
      return "Closed. The period's figures are final.";
    case "rejected":
      return "Rejected by the owner. The period is still open.";
    case "expired":
      return "Expired: no decision was made in time. The period is still open.";
    case "failed":
      return "Failed. The period is still open and the close can be started again.";
  }
}

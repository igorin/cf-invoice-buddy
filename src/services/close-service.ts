import {
  listCloses,
  moveClose,
  readClose,
  readCloseByWorkflow,
  saveSnapshot,
  saveSummary,
  startClose,
  type StoredClose
} from "../db/close-store";
import {
  isPeriodSynced,
  readBilling,
  readInvoiceAmount,
  readUsage,
  type Dataset
} from "../db/usage-store";
import {
  checkCloseStart,
  describeCloseState,
  summariseClose,
  type CloseState,
  type CloseSummary,
  type StartCheck
} from "../domain/close";
import {
  addDays,
  isoDate,
  periodContaining,
  precedingPeriods,
  previousPeriod,
  type BillingPeriod,
  type IsoDate
} from "../domain/periods";
import { MONTH_PATTERN } from "./explain-service";

/**
 * The monthly invoice close (spec UC-6, section 8). The workflow in
 * src/workflows/invoice-close.ts drives the steps; the work is done here,
 * on the agent's own database. Every step can be run twice without harm
 * (NFR-O1), and nothing changes a close once it is closed.
 */

type Sql = DurableObjectStorage["sql"];

const BASELINE_PERIODS = 3;
const MAX_REASON_CHARS = 500;

export type CloseView = Readonly<{
  dataset: Dataset;
  testData: boolean;
  month: string;
  workflowId: string;
  state: CloseState;
  stateInWords: string;
  /** True once the owner has approved; the workflow then finalizes. */
  approved: boolean;
  summary: Partial<CloseSummary> | null;
  decidedReason: string | null;
  startedAt: string;
  closedAt: string | null;
}>;

export type StartResult =
  | Readonly<{ status: "started"; close: CloseView }>
  | Readonly<{
      status: Exclude<StartCheck, "ok">;
      month: string;
      close: CloseView | null;
    }>;

/** The steps the workflow asks for, in order, and the three ways it can end early. */
export type CloseStep =
  | "snapshot"
  | "rate"
  | "anomaly-check"
  | "finalize"
  | "reject"
  | "expire"
  | "fail";

export function viewClose(close: StoredClose): CloseView {
  return {
    dataset: close.dataset,
    testData: close.dataset === "test",
    month: close.periodStart.slice(0, 7),
    workflowId: close.workflowId,
    state: close.state,
    stateInWords:
      close.state === "awaiting_approval" && close.approvedAt !== null
        ? "Approved by the owner. The close is being finalized."
        : describeCloseState(close.state),
    approved: close.approvedAt !== null,
    summary: close.summary,
    decidedReason: close.decidedReason,
    startedAt: close.startedAt,
    closedAt: close.closedAt
  };
}

/** The period a close is for: the month named, or the last finished one. */
export function periodToClose(
  month: string | undefined,
  today: IsoDate,
  anchorDay: number
): BillingPeriod {
  if (month !== undefined && MONTH_PATTERN.test(month)) {
    return periodContaining(isoDate(`${month}-15`), anchorDay);
  }
  return previousPeriod(periodContaining(today, anchorDay), anchorDay);
}

/** Records the start of a close, if one may start. Starts no workflow. */
export function beginClose(
  sql: Sql,
  dataset: Dataset,
  period: BillingPeriod,
  today: IsoDate,
  now: Date
): StartResult {
  const existing = readClose(sql, dataset, period.start);
  const check = checkCloseStart(period, today, existing?.state ?? null);
  if (check !== "ok") {
    return {
      status: check,
      month: period.start.slice(0, 7),
      close: existing ? viewClose(existing) : null
    };
  }
  // Workflow ids are shared by every agent instance, so they are random.
  const workflowId = `close-${dataset}-${period.start}-${crypto.randomUUID().slice(0, 8)}`;
  startClose(
    sql,
    { dataset, periodStart: period.start, periodEnd: period.end, workflowId },
    now.toISOString()
  );
  const started = readClose(sql, dataset, period.start);
  if (started === null) throw new Error("The close could not be recorded");
  return { status: "started", close: viewClose(started) };
}

function summaryFor(sql: Sql, close: StoredClose, anchorDay: number) {
  const period: BillingPeriod = {
    start: isoDate(close.periodStart),
    end: isoDate(close.periodEnd)
  };
  const baselines = precedingPeriods(period, anchorDay, BASELINE_PERIODS)
    .filter((candidate) => isPeriodSynced(sql, close.dataset, candidate.start))
    .map((candidate) => ({
      period: candidate,
      records: readUsage(
        sql,
        close.dataset,
        candidate.start,
        addDays(candidate.end, -1)
      )
    }));
  return summariseClose({
    period,
    snapshot: close.snapshot ?? [],
    baseline: { chosenByOwner: false, periods: baselines },
    invoiceMicros: readInvoiceAmount(sql, close.dataset, period.start),
    billing: readBilling(sql, close.dataset)?.billing ?? {
      status: "unavailable",
      reason: "billing data has not been read yet"
    }
  });
}

/**
 * Runs one step of a close. A step for a workflow run that no longer owns
 * the close, or for a close that is already closed, does nothing.
 */
export function runCloseStep(
  sql: Sql,
  workflowId: string,
  step: CloseStep,
  anchorDay: number,
  now: Date
): CloseView | null {
  const close = readCloseByWorkflow(sql, workflowId);
  if (close === null) return null;
  const at = now.toISOString();
  switch (step) {
    case "snapshot":
      // Kept if the step runs again, so later data cannot alter the close.
      saveSnapshot(
        sql,
        workflowId,
        readUsage(
          sql,
          close.dataset,
          isoDate(close.periodStart),
          addDays(isoDate(close.periodEnd), -1)
        ),
        at
      );
      break;
    case "rate": {
      const { month, total, lineItems, reconciliation, usageRecords } =
        summaryFor(sql, close, anchorDay);
      saveSummary(
        sql,
        workflowId,
        { month, total, lineItems, reconciliation, usageRecords },
        at
      );
      break;
    }
    case "anomaly-check":
      if (close.state === "snapshotted") {
        saveSummary(sql, workflowId, summaryFor(sql, close, anchorDay), at);
        moveClose(sql, workflowId, {
          from: ["snapshotted"],
          to: "awaiting_approval",
          at
        });
      }
      break;
    case "finalize":
      // Only a close the owner approved in the UI can be finalized (NFR-S3).
      if (close.approvedAt !== null) {
        moveClose(sql, workflowId, {
          from: ["awaiting_approval"],
          to: "closed",
          at
        });
      }
      break;
    case "reject":
    case "expire":
    case "fail":
      moveClose(sql, workflowId, {
        from: ["snapshotted", "awaiting_approval"],
        to:
          step === "reject"
            ? "rejected"
            : step === "expire"
              ? "expired"
              : "failed",
        at
      });
      break;
  }
  const after = readCloseByWorkflow(sql, workflowId);
  return after ? viewClose(after) : null;
}

export type Decision = Readonly<{ approved: boolean; reason?: string | null }>;

export type DecisionResult =
  | Readonly<{ status: "approved" | "rejected"; close: CloseView }>
  | Readonly<{ status: "not_pending" }>;

/**
 * Records the owner's decision on a close that is waiting for one. Approval
 * is only noted here; the workflow then finalizes. Rejection takes effect at
 * once and leaves the period open.
 */
export function decideClose(
  sql: Sql,
  dataset: Dataset,
  workflowId: string,
  decision: Decision,
  now: Date
): DecisionResult {
  const close = readCloseByWorkflow(sql, workflowId);
  if (
    close === null ||
    close.dataset !== dataset ||
    close.state !== "awaiting_approval" ||
    close.approvedAt !== null
  ) {
    return { status: "not_pending" };
  }
  const reason =
    decision.reason?.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS) ||
    null;
  moveClose(sql, workflowId, {
    from: ["awaiting_approval"],
    to: decision.approved ? "awaiting_approval" : "rejected",
    at: now.toISOString(),
    reason,
    approved: decision.approved
  });
  const after = readCloseByWorkflow(sql, workflowId);
  return {
    status: decision.approved ? "approved" : "rejected",
    close: viewClose(after ?? close)
  };
}

export function listCloseViews(sql: Sql, dataset: Dataset): CloseView[] {
  return listCloses(sql, dataset).map(viewClose);
}

/** Closes waiting for the owner's decision, for the approval card. */
export function pendingCloses(sql: Sql, dataset: Dataset): CloseView[] {
  return listCloseViews(sql, dataset).filter(
    (close) =>
      close.state === "awaiting_approval" &&
      !close.approved &&
      close.summary !== null
  );
}

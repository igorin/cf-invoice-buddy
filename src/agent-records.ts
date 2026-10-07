import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import type { AgentState } from "./agent-state";
import type { IsoDate } from "./domain/periods";
import {
  beginClose,
  decideClose,
  listCloseViews,
  pendingCloses,
  periodToClose,
  runCloseStep,
  type CloseStep,
  type CloseView,
  type DecisionResult,
  type StartResult
} from "./services/close-service";
import {
  draftCredit,
  listCreditViews,
  reportCreditOutcome,
  type CreditView,
  type DraftRequest,
  type DraftResult,
  type OutcomeRequest,
  type OutcomeResult
} from "./services/credit-service";
import type {
  ExplainRequest,
  ExplanationView
} from "./services/explain-service";

/** The Workflow binding that runs an invoice close (wrangler.jsonc). */
export const CLOSE_WORKFLOW = "INVOICE_CLOSE_WORKFLOW";

// Accounts with no billing cycle are summarised by calendar month.
export const LIVE_ANCHOR_DAY = 1;

// Audit entries for what the owner did or said; the rest are the agent's.
const OWNER_ACTIONS = new Set([
  "set_data_mode",
  "credit_outcome",
  "close_approved",
  "close_rejected"
]);

/**
 * The records the owner keeps with the assistant: credit request drafts
 * (UC-3, UC-4) and invoice closes (UC-6), with the audit log they share.
 * The chat, the data and the cost meter are in InvoiceBuddyAgent, which
 * extends this class.
 */
export abstract class RecordsAgent extends AIChatAgent<Env, AgentState> {
  protected abstract today(): IsoDate;
  abstract explainBill(request?: ExplainRequest): Promise<ExplanationView>;

  protected audit(
    action: string,
    subject: string | null,
    detail?: unknown
  ): void {
    this.sql`
      INSERT INTO audit_log (at, actor, action, subject_id, dataset, detail_json)
      VALUES (${new Date().toISOString()}, ${OWNER_ACTIONS.has(action) ? "owner" : "agent"},
        ${action}, ${subject}, ${this.state.dataMode.dataset},
        ${detail === undefined ? null : JSON.stringify(detail)})`;
  }

  /** Writes and stores a credit request draft (UC-3). Submits nothing. */
  @callable()
  async draftCreditRequest(request: DraftRequest): Promise<DraftResult> {
    const explanation = await this.explainBill(
      request.month ? { month: request.month } : {}
    );
    const sql = this.ctx.storage.sql;
    const result = draftCredit(sql, explanation, request, new Date());
    if (result.status === "drafted" || result.status === "replaced") {
      this.audit("credit_draft", result.request.id, result.status);
    }
    return result;
  }

  /** The drafts written so far, in the current data mode (UC-4). */
  @callable()
  getCreditRequests(): CreditView[] {
    return listCreditViews(this.ctx.storage.sql, this.state.dataMode.dataset);
  }

  /** Stores what the owner says became of a request (UC-4). Never verified. */
  @callable()
  recordCreditOutcome(request: OutcomeRequest): OutcomeResult {
    const dataset = this.state.dataMode.dataset;
    const sql = this.ctx.storage.sql;
    const result = reportCreditOutcome(sql, dataset, request, new Date());
    if (result.status === "recorded") {
      this.audit("credit_outcome", result.request.id, result.request.state);
    }
    return result;
  }

  /**
   * Starts the close of a finished period (UC-6): the month named, or the
   * last finished one. It ends at the owner's approval, which only the
   * approval card in the UI can give.
   */
  @callable()
  async startInvoiceClose(month?: unknown): Promise<StartResult> {
    const sql = this.ctx.storage.sql;
    const today = this.today();
    const period = periodToClose(
      typeof month === "string" ? month.trim() : undefined,
      today,
      LIVE_ANCHOR_DAY
    );
    // Makes sure a finished period's usage is stored before it is frozen.
    if (period.end <= today) {
      await this.explainBill({ month: period.start.slice(0, 7) });
    }
    const dataset = this.state.dataMode.dataset;
    const result = beginClose(sql, dataset, period, today, new Date());
    if (result.status !== "started") return result;
    const { workflowId } = result.close;
    this.audit("close_started", workflowId, result.close.month);
    try {
      await this.runWorkflow(
        CLOSE_WORKFLOW,
        { workflowId },
        { id: workflowId }
      );
    } catch (error) {
      await this.closeStep(workflowId, "fail");
      throw error;
    }
    return result;
  }

  /** The closes of the current data mode, newest period first (UC-6). */
  @callable()
  getInvoiceCloses(): CloseView[] {
    return listCloseViews(this.ctx.storage.sql, this.state.dataMode.dataset);
  }

  /**
   * The owner's decision on a close, from the approval card (NFR-S3). No
   * model-callable tool reaches this method.
   */
  @callable()
  async decideClose(
    workflowId: unknown,
    approved: unknown,
    reason?: unknown
  ): Promise<DecisionResult> {
    if (typeof workflowId !== "string" || typeof approved !== "boolean") {
      return { status: "not_pending" };
    }
    const note = typeof reason === "string" ? reason : null;
    const result = decideClose(
      this.ctx.storage.sql,
      this.state.dataMode.dataset,
      workflowId,
      { approved, reason: note },
      new Date()
    );
    if (result.status === "not_pending") return result;
    this.audit(
      approved ? "close_approved" : "close_rejected",
      workflowId,
      result.close.decidedReason
    );
    this.publishApprovals();
    const data = result.close.decidedReason
      ? { reason: result.close.decidedReason }
      : undefined;
    if (approved) await this.approveWorkflow(workflowId, data);
    else await this.rejectWorkflow(workflowId, data);
    return result;
  }

  /**
   * Runs one step of a close. Called by the workflow over RPC; it is not
   * exposed to the browser. Returns the close's state afterwards.
   */
  async closeStep(workflowId: string, step: CloseStep): Promise<string | null> {
    const sql = this.ctx.storage.sql;
    const close = runCloseStep(
      sql,
      workflowId,
      step,
      LIVE_ANCHOR_DAY,
      new Date()
    );
    this.publishApprovals();
    return close?.state ?? null;
  }

  /** A workflow that fails leaves its period open. */
  override async onWorkflowError(
    _workflowName: string,
    workflowId: string
  ): Promise<void> {
    await this.closeStep(workflowId, "fail");
  }

  /** Puts the closes waiting for a decision into the synced state. */
  protected publishApprovals(): void {
    const sql = this.ctx.storage.sql;
    this.setState({
      ...this.state,
      pendingApprovals: pendingCloses(sql, this.state.dataMode.dataset)
    });
  }
}

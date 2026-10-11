import { AIChatAgent } from "@cloudflare/ai-chat";
import { callable } from "agents";
import type { AgentState } from "./agent-state";
import type { IsoDate } from "./domain/periods";
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

// Accounts with no billing cycle are summarised by calendar month.
export const LIVE_ANCHOR_DAY = 1;

// Audit entries for what the owner did or said; the rest are the agent's.
const OWNER_ACTIONS = new Set(["set_data_mode", "credit_outcome"]);

/**
 * The records the owner keeps with the assistant: credit request drafts
 * (UC-3, UC-4), with the audit log.
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
}

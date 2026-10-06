import {
  AIChatAgent,
  type ChatResponseResult,
  type OnChatMessageOptions
} from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel
} from "ai";
import { CloudflareBillingSource } from "./adapters/billing";
import { CloudflareDocsSearch } from "./adapters/docs-search";
import { GraphqlUsageSource } from "./adapters/graphql-usage";
import { readConfig, type Config } from "./config";
import { runMigrations } from "./db/schema";
import {
  isPeriodSynced,
  readBilling,
  readSourceStatus,
  readUsage,
  type Dataset
} from "./db/usage-store";
import { ALLOWANCE_SOURCE } from "./domain/allowances";
import {
  isoDate,
  periodContaining,
  type BillingPeriod,
  type IsoDate
} from "./domain/periods";
import { SCENARIOS } from "./domain/scenarios";
import { checkBudget } from "./domain/self-cost";
import { buildUsageSummary } from "./domain/usage-summary";
import type {
  BillingSource,
  DocsSearch,
  DocsSearchResult,
  UsageSource
} from "./ports/sources";
import { buildSystemPrompt } from "./prompt";
import {
  bumpDailyCounter,
  readCostReport,
  readMonthCost,
  readNeuronsInWindow,
  recordTurn,
  type CostReport
} from "./db/self-usage-store";
import { checkedResponse } from "./services/grounding-service";
import {
  reportTurnError,
  hasVisibleReply,
  isLooping
} from "./services/turn-guard";
import { fetchClosedMonth, syncCurrentPeriod } from "./services/usage-sync";
import {
  explainStoredBill,
  type ExplainRequest,
  type ExplanationView
} from "./services/explain-service";
import type { RecordedCall } from "./domain/model-recording";
import { chooseModel, createModel, type ModelRequest } from "./model";
import { loadScenario } from "./services/scenario-service";
import { buildTools } from "./tools";

// The model has a 24,000-token context window, so turns are kept short.
const MAX_STEPS_PER_TURN = 5;
// A model stream silent for this long is treated as hung and aborted.
const STREAM_STALL_TIMEOUT_MS = 45_000;
export const SMOKE_SUFFIX = "-smoke";
const MAX_QUERY_CHARS = 200;

export const NO_ANSWER_MESSAGE =
  "I couldn't complete that answer. Please try asking again, or rephrase the question.";

export const BUDGET_EXHAUSTED_MESSAGE =
  "This assistant's usage budget for the last 24 hours is used up. It frees up as earlier usage passes the 24-hour mark.";

// Accounts with no billing cycle are summarised by calendar month.
const LIVE_ANCHOR_DAY = 1;
const SYNC_CRON = "0 */6 * * *";

export * from "./agent-state";
import {
  INITIAL_STATE,
  type AgentState,
  type DataMode,
  type UsageSummaryView
} from "./agent-state";
export { MODEL_ID, createModel } from "./model";

export class InvoiceBuddyAgent extends AIChatAgent<Env, AgentState> {
  static modelFactory: (env: Env, request?: ModelRequest) => LanguageModel =
    createModel;
  static clock: () => Date = () => new Date();
  static usageSourceFactory: (config: Config) => UsageSource = (config) =>
    new GraphqlUsageSource(config.CF_ACCOUNT_ID, config.CF_API_TOKEN);
  static billingSourceFactory: (config: Config) => BillingSource = (config) =>
    new CloudflareBillingSource(config.CF_ACCOUNT_ID, config.CF_API_TOKEN);
  static docsSearchFactory: () => DocsSearch = () => new CloudflareDocsSearch();

  override maxPersistedMessages = 200;
  override chatStreamStallTimeoutMs = STREAM_STALL_TIMEOUT_MS;

  override initialState: AgentState = INITIAL_STATE;
  /** Raw model streams kept for the recording script; local runs only. */
  private recordedCalls: RecordedCall[] = [];

  override async onStart(): Promise<void> {
    runMigrations(this.ctx.storage.sql);
    // State saved by an earlier version may lack newer fields.
    this.setState({ ...INITIAL_STATE, ...this.state });
    this.publishSelfCost();
    // Cron schedules are idempotent, so this is safe on every start.
    await this.schedule(SYNC_CRON, "syncUsage");
  }

  override async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ) {
    // The budget is enforced in code before any model call (NFR-O3).
    if (
      checkBudget(this.neuronsInWindow(), this.dailyBudget()) === "exhausted"
    ) {
      bumpDailyCounter(this.ctx.storage.sql, this.today(), "refused_turns");
      return new Response(BUDGET_EXHAUSTED_MESSAGE);
    }

    const smoke = this.name.endsWith(SMOKE_SUFFIX);
    const result = streamText({
      model: InvoiceBuddyAgent.modelFactory(this.env, {
        smoke,
        onRecordedCall: (call) => this.recordedCalls.push(call)
      }),
      system: buildSystemPrompt(this.today()),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildTools(this),
      // Stops at the step limit, or sooner if the turn is going in circles.
      stopWhen: [stepCountIs(MAX_STEPS_PER_TURN), isLooping],
      abortSignal: options?.abortSignal,
      onFinish: ({ totalUsage, steps }) => {
        recordTurn(
          this.ctx.storage.sql,
          {
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
            steps: steps.length
          },
          chooseModel(this.env, smoke).modelId,
          this.today()
        );
        this.publishSelfCost();
      }
    });

    // Text is held until the response checker has passed it (section 7).
    return checkedResponse(
      result.toUIMessageStream({ onError: reportTurnError }),
      this.messages,
      (violations) => this.audit("grounding_violation", null, violations)
    );
  }

  /**
   * A turn that ends with no text, for example one stopped by the loop
   * guard, gets a fixed line so the owner is never left with silence.
   */
  protected override async onChatResponse(result: ChatResponseResult) {
    if (result.status !== "completed") return;
    if (!hasVisibleReply(result.message)) {
      await this.appendNotice(NO_ANSWER_MESSAGE);
    }
  }

  /** Adds a fixed assistant message to the chat without calling the model. */
  private async appendNotice(text: string): Promise<void> {
    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [{ type: "text", text }]
      }
    ]);
  }

  private audit(
    action: string,
    subject: string | null,
    detail?: unknown
  ): void {
    this.sql`
      INSERT INTO audit_log (at, actor, action, subject_id, dataset, detail_json)
      VALUES (${new Date().toISOString()}, ${action === "set_data_mode" ? "owner" : "agent"},
        ${action}, ${subject}, ${this.state.dataMode.dataset},
        ${detail === undefined ? null : JSON.stringify(detail)})`;
  }

  /** Hands over, once, the model streams recorded since the last call. */
  @callable()
  takeRecordedCalls(): RecordedCall[] {
    return this.recordedCalls.splice(0);
  }

  /** Searches Cloudflare's documentation (rule G-2b). No model call. */
  @callable()
  async searchDocs(query: unknown): Promise<DocsSearchResult> {
    if (typeof query !== "string" || query.trim() === "") {
      return { ok: false, reason: "a search needs a question" };
    }
    return InvoiceBuddyAgent.docsSearchFactory().search(
      query.slice(0, MAX_QUERY_CHARS)
    );
  }

  /** Pulls the current period's usage and billing status for the live dataset. */
  async syncUsage(): Promise<void> {
    const result = readConfig(this.env);
    if (!result.ok) return;
    const today = this.today();
    const at = await syncCurrentPeriod(
      this.ctx.storage.sql,
      InvoiceBuddyAgent.usageSourceFactory(result.config),
      InvoiceBuddyAgent.billingSourceFactory(result.config),
      periodContaining(today, LIVE_ANCHOR_DAY),
      today
    );
    this.setState({ ...this.state, lastSyncAt: at });
  }

  @callable()
  async getUsageSummary(): Promise<UsageSummaryView> {
    const mode = this.state.dataMode;
    const sql = this.ctx.storage.sql;
    if (mode.dataset === "live" && readBilling(sql, "live") === null) {
      await this.syncUsage();
    }
    const today = this.today();
    const period = periodContaining(today, LIVE_ANCHOR_DAY);
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

  /**
   * Switches between live data and a test scenario (UC-10). Reached only
   * from the owner's switch in the UI or an owner-approved tool call.
   */
  @callable()
  async setDataMode(dataset: unknown, scenario?: unknown): Promise<DataMode> {
    if (dataset !== "live" && dataset !== "test") {
      throw new Error("Unknown data mode");
    }
    const mode: DataMode =
      dataset === "live"
        ? { dataset }
        : loadScenario(this.ctx.storage.sql, scenario, this.today());
    this.setState({ ...this.state, dataMode: mode });
    this.audit("set_data_mode", mode.dataset === "test" ? mode.scenario : null);
    const title = SCENARIOS.find(
      (s) => mode.dataset === "test" && s.id === mode.scenario
    )?.title;
    await this.appendNotice(
      title
        ? `Switched to test mode: ${title}. Figures are fixture data.`
        : "Switched to live data."
    );
    return mode;
  }

  /** Explains a month's bill (UC-1, UC-2). See explain-service.ts. */
  @callable()
  async explainBill(request: ExplainRequest = {}): Promise<ExplanationView> {
    const mode = this.state.dataMode;
    const today = this.today();
    return explainStoredBill(request, {
      sql: this.ctx.storage.sql,
      dataset: mode.dataset,
      scenario: mode.dataset === "test" ? mode.scenario : null,
      today,
      anchorDay: LIVE_ANCHOR_DAY,
      ensurePeriod: (period) => this.ensurePeriod(mode.dataset, period, today)
    });
  }

  /** What the assistant itself has cost (UC-8). Always real, in either mode. */
  @callable()
  getAssistantCost(): CostReport {
    return readCostReport(
      this.ctx.storage.sql,
      this.today(),
      this.neuronsInWindow(),
      this.dailyBudget()
    );
  }

  /** Makes sure a period's usage is stored, fetching a live month on demand. */
  private async ensurePeriod(
    dataset: Dataset,
    period: BillingPeriod,
    today: IsoDate
  ): Promise<void> {
    const sql = this.ctx.storage.sql;
    if (dataset === "test" || isPeriodSynced(sql, dataset, period.start))
      return;
    if (period.end > today) {
      await this.syncUsage();
      return;
    }
    const result = readConfig(this.env);
    if (!result.ok) return;
    await fetchClosedMonth(
      sql,
      InvoiceBuddyAgent.usageSourceFactory(result.config),
      period
    );
  }

  /**
   * The instance's daily neuron budget. The smoke-test instance has its own,
   * so that all budgets together stay under the account's free allowance.
   */
  private dailyBudget(): number {
    const result = readConfig(this.env);
    // With no valid budget configured, refuse rather than spend unbounded.
    if (!result.ok) return 0;
    return this.name.endsWith(SMOKE_SUFFIX)
      ? result.config.SMOKE_DAILY_NEURON_BUDGET
      : result.config.DAILY_NEURON_BUDGET;
  }

  private today(): IsoDate {
    return isoDate(InvoiceBuddyAgent.clock().toISOString().slice(0, 10));
  }

  private neuronsInWindow(): number {
    return readNeuronsInWindow(this.ctx.storage.sql, new Date());
  }

  private publishSelfCost(): void {
    const month = readMonthCost(this.ctx.storage.sql, this.today());
    this.setState({
      ...this.state,
      selfCost: {
        monthCostMicros: month.costMicros,
        windowNeurons: this.neuronsInWindow(),
        dailyBudgetNeurons: this.dailyBudget(),
        unmeteredTurns: month.unmeteredTurns
      }
    });
  }
}

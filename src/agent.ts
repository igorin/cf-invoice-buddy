import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { CloudflareBillingSource } from "./adapters/billing";
import { GraphqlUsageSource } from "./adapters/graphql-usage";
import { readConfig, type Config } from "./config";
import { runMigrations } from "./db/schema";
import {
  isPeriodSynced,
  markPeriodSynced,
  readBilling,
  readSourceStatus,
  readUsage,
  replaceUsage,
  saveBilling,
  saveSourceStatus,
  type Dataset
} from "./db/usage-store";
import { ALLOWANCE_SOURCE, type Plan } from "./domain/allowances";
import { withDedupedStream } from "./domain/dedupe-stream";
import {
  addDays,
  isoDate,
  periodContaining,
  type BillingPeriod,
  type IsoDate
} from "./domain/periods";
import { SCENARIOS, type ScenarioId } from "./domain/scenarios";
import { checkBudget, meterTurn } from "./domain/self-cost";
import { buildUsageSummary, type UsageSummary } from "./domain/usage-summary";
import type { BillingSource, UsageSource } from "./ports/sources";
import { buildSystemPrompt } from "./prompt";
import { readCostReport, type CostReport } from "./db/self-usage-store";
import {
  explainStoredBill,
  type ExplainRequest,
  type ExplanationView
} from "./services/explain-service";
import { loadScenario } from "./services/scenario-service";
import { buildTools } from "./tools";

export const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// The model has a 24,000-token context window, so turns are kept short.
const MAX_STEPS_PER_TURN = 8;

export const BUDGET_EXHAUSTED_MESSAGE =
  "Today's usage budget for this assistant is used up. It resets at 00:00 UTC.";

export type SelfCost = Readonly<{
  monthCostMicros: number;
  todayNeurons: number;
  dailyBudgetNeurons: number;
  unmeteredTurns: number;
}>;

export type DataMode =
  | Readonly<{ dataset: "live" }>
  | Readonly<{ dataset: "test"; scenario: ScenarioId }>;

export type AgentState = Readonly<{
  selfCost: SelfCost;
  dataMode: DataMode;
  lastSyncAt: string | null;
}>;

/** What the usage panel and the usage tool are built from (UC-9). */
export type UsageSummaryView = UsageSummary &
  Readonly<{
    dataset: Dataset;
    scenario: ScenarioId | null;
    plan: Plan;
    lastSyncAt: string | null;
    allowanceSource: typeof ALLOWANCE_SOURCE;
  }>;

// Accounts with no billing cycle are summarised by calendar month.
const LIVE_ANCHOR_DAY = 1;
const SYNC_CRON = "0 */6 * * *";

const INITIAL_STATE: AgentState = {
  selfCost: {
    monthCostMicros: 0,
    todayNeurons: 0,
    dailyBudgetNeurons: 0,
    unmeteredTurns: 0
  },
  dataMode: { dataset: "live" },
  lastSyncAt: null
};

type TurnUsage = Readonly<{
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  steps: number;
}>;

/** Builds the chat model. Tests replace `InvoiceBuddyAgent.modelFactory`. */
export function createModel(env: Env): LanguageModel {
  // Llama 3.3 streams each text chunk in two fields; see dedupe-stream.ts.
  const workersai = createWorkersAI({ binding: withDedupedStream(env.AI) });
  return workersai(MODEL_ID);
}

export class InvoiceBuddyAgent extends AIChatAgent<Env, AgentState> {
  static modelFactory: (env: Env) => LanguageModel = createModel;
  static usageSourceFactory: (config: Config) => UsageSource = (config) =>
    new GraphqlUsageSource(config.CF_ACCOUNT_ID, config.CF_API_TOKEN);
  static billingSourceFactory: (config: Config) => BillingSource = (config) =>
    new CloudflareBillingSource(config.CF_ACCOUNT_ID, config.CF_API_TOKEN);

  override maxPersistedMessages = 200;

  override initialState: AgentState = INITIAL_STATE;

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
    if (checkBudget(this.neuronsToday(), this.dailyBudget()) === "exhausted") {
      this.recordRefusal();
      return new Response(BUDGET_EXHAUSTED_MESSAGE);
    }

    const result = streamText({
      model: InvoiceBuddyAgent.modelFactory(this.env),
      system: buildSystemPrompt(this.today()),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: buildTools(this),
      stopWhen: stepCountIs(MAX_STEPS_PER_TURN),
      abortSignal: options?.abortSignal,
      onFinish: ({ totalUsage, steps }) => {
        this.recordTurn({
          inputTokens: totalUsage.inputTokens,
          outputTokens: totalUsage.outputTokens,
          steps: steps.length
        });
      }
    });

    return result.toUIMessageStreamResponse();
  }

  /** Pulls the current period's usage and billing status for the live dataset. */
  async syncUsage(): Promise<void> {
    const result = readConfig(this.env);
    if (!result.ok) return;
    const today = this.today();
    const period = periodContaining(today, LIVE_ANCHOR_DAY);
    const [usage, billing] = await Promise.all([
      InvoiceBuddyAgent.usageSourceFactory(result.config).fetchUsage(
        period.start,
        today
      ),
      InvoiceBuddyAgent.billingSourceFactory(result.config).fetchBilling()
    ]);
    const at = new Date().toISOString();
    const sql = this.ctx.storage.sql;
    // Rows of a product that failed are left as they were; its status is
    // what keeps them out of the summary.
    const readable = usage.sources
      .filter((s) => s.available)
      .map((s) => s.service);
    replaceUsage(sql, "live", readable, period.start, today, usage.records);
    markPeriodSynced(sql, "live", period.start, at);
    saveSourceStatus(sql, "live", usage.sources, at);
    saveBilling(sql, "live", billing.billing, billing.plan, at);
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
    this.sql`
      INSERT INTO audit_log (at, actor, action, subject_id, dataset)
      VALUES (${new Date().toISOString()}, 'owner', 'set_data_mode',
        ${mode.dataset === "test" ? mode.scenario : null}, ${mode.dataset})`;
    this.setState({ ...this.state, dataMode: mode });
    const title = SCENARIOS.find(
      (s) => mode.dataset === "test" && s.id === mode.scenario
    )?.title;
    await this.persistMessages([
      ...this.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        parts: [
          {
            type: "text",
            text: title
              ? `Switched to test mode: ${title}. Figures are fixture data.`
              : "Switched to live data."
          }
        ]
      }
    ]);
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
      this.neuronsToday(),
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
    const last = addDays(period.end, -1);
    const usage = await InvoiceBuddyAgent.usageSourceFactory(
      result.config
    ).fetchUsage(period.start, last);
    const readable = usage.sources
      .filter((s) => s.available)
      .map((s) => s.service);
    replaceUsage(sql, "live", readable, period.start, last, usage.records);
    // A month with a failed product is fetched again next time it is asked for.
    if (usage.sources.every((source) => source.available)) {
      markPeriodSynced(sql, "live", period.start, new Date().toISOString());
    }
  }

  private dailyBudget(): number {
    const result = readConfig(this.env);
    // With no valid budget configured, refuse rather than spend unbounded.
    return result.ok ? result.config.DAILY_NEURON_BUDGET : 0;
  }

  private today(): IsoDate {
    return isoDate(new Date().toISOString().slice(0, 10));
  }

  private neuronsToday(): number {
    const [row] = this.sql<{ total: number | null }>`
      SELECT SUM(neurons) AS total FROM self_usage
      WHERE at >= ${this.today()}`;
    return row?.total ?? 0;
  }

  private recordTurn(usage: TurnUsage): void {
    const turn = meterTurn(
      usage.inputTokens === undefined
        ? undefined
        : {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens ?? 0
          }
    );
    const at = new Date().toISOString();
    if (turn.metered) {
      this.sql`
        INSERT INTO self_usage
          (at, model, steps, input_tokens, output_tokens, neurons, cost_micros, metered)
        VALUES (${at}, ${MODEL_ID}, ${usage.steps}, ${turn.inputTokens},
          ${turn.outputTokens}, ${turn.neurons}, ${turn.costMicros}, 1)`;
    } else {
      this.sql`
        INSERT INTO self_usage (at, model, steps, metered)
        VALUES (${at}, ${MODEL_ID}, ${usage.steps}, 0)`;
    }
    this.sql`
      INSERT INTO self_activity_daily (day, chat_turns) VALUES (${this.today()}, 1)
      ON CONFLICT (day) DO UPDATE SET chat_turns = chat_turns + 1`;
    this.publishSelfCost();
  }

  private recordRefusal(): void {
    this.sql`
      INSERT INTO self_activity_daily (day, refused_turns) VALUES (${this.today()}, 1)
      ON CONFLICT (day) DO UPDATE SET refused_turns = refused_turns + 1`;
  }

  private publishSelfCost(): void {
    const monthStart = `${this.today().slice(0, 7)}-01`;
    const [month] = this.sql<{ cost: number | null; unmetered: number }>`
      SELECT SUM(cost_micros) AS cost,
        COALESCE(SUM(CASE WHEN metered = 0 THEN 1 ELSE 0 END), 0) AS unmetered
      FROM self_usage WHERE at >= ${monthStart}`;
    this.setState({
      ...this.state,
      selfCost: {
        monthCostMicros: month?.cost ?? 0,
        todayNeurons: this.neuronsToday(),
        dailyBudgetNeurons: this.dailyBudget(),
        unmeteredTurns: month?.unmetered ?? 0
      }
    });
  }
}

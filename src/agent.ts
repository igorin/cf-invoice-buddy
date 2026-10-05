import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  type LanguageModel
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { readConfig } from "./config";
import { runMigrations } from "./db/schema";
import { withDedupedStream } from "./domain/dedupe-stream";
import { checkBudget, meterTurn } from "./domain/self-cost";
import { SYSTEM_PROMPT } from "./prompt";

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

export type AgentState = Readonly<{ selfCost: SelfCost }>;

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

  override maxPersistedMessages = 200;

  override initialState: AgentState = {
    selfCost: {
      monthCostMicros: 0,
      todayNeurons: 0,
      dailyBudgetNeurons: 0,
      unmeteredTurns: 0
    }
  };

  override onStart(): void {
    runMigrations(this.ctx.storage.sql);
    this.publishSelfCost();
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
      system: SYSTEM_PROMPT,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
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

  private dailyBudget(): number {
    const result = readConfig(this.env);
    // With no valid budget configured, refuse rather than spend unbounded.
    return result.ok ? result.config.DAILY_NEURON_BUDGET : 0;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
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
      selfCost: {
        monthCostMicros: month?.cost ?? 0,
        todayNeurons: this.neuronsToday(),
        dailyBudgetNeurons: this.dailyBudget(),
        unmeteredTurns: month?.unmetered ?? 0
      }
    });
  }
}

import { formatUsd, micros } from "../domain/money";
import {
  addDays,
  isoDate,
  type BillingPeriod,
  type IsoDate
} from "../domain/periods";
import { LLAMA_3_3_PRICE, meterTurn } from "../domain/self-cost";

/**
 * Reads the assistant's own cost meter (spec UC-8). The meter is always
 * real: it has no dataset and is the same in live and test mode.
 */

type Sql = {
  exec(
    query: string,
    ...bindings: unknown[]
  ): Iterable<Record<string, unknown>>;
};

const COST_REPORT_DAYS = 7;

const count = (value: unknown): string =>
  Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

const cost = (value: unknown): string => formatUsd(micros(Number(value ?? 0)));

const first = (rows: Iterable<Record<string, unknown>>) => [...rows][0] ?? {};

/** The assistant's cost report, with every figure as text. */
export function readCostReport(
  sql: Sql,
  today: IsoDate,
  neuronsToday: number,
  dailyBudget: number
) {
  const monthStart = isoDate(`${today.slice(0, 7)}-01`);
  const month = first(
    sql.exec(
      `SELECT COUNT(*) AS turns,
        COALESCE(SUM(CASE WHEN metered = 0 THEN 1 ELSE 0 END), 0) AS unmetered,
        SUM(cost_micros) AS cost, SUM(neurons) AS neurons,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output
       FROM self_usage WHERE at >= ?`,
      monthStart
    )
  );
  const refused = first(
    sql.exec(
      "SELECT SUM(refused_turns) AS refused FROM self_activity_daily WHERE day >= ?",
      monthStart
    )
  );
  const days = sql.exec(
    `SELECT substr(at, 1, 10) AS day, COUNT(*) AS turns,
      SUM(neurons) AS neurons, SUM(cost_micros) AS cost
     FROM self_usage WHERE at >= ? GROUP BY day ORDER BY day`,
    addDays(today, -(COST_REPORT_DAYS - 1))
  );
  return {
    notice: "This is the assistant's own real usage. It is never test data.",
    monthToDate: {
      meteredModelCost: cost(month.cost),
      neurons: count(month.neurons),
      inputTokens: count(month.input),
      outputTokens: count(month.output),
      chatTurns: count(month.turns),
      unmeteredTurns: count(month.unmetered),
      turnsRefusedOverBudget: count(refused.refused)
    },
    today: {
      neurons: count(neuronsToday),
      dailyBudget: `${count(dailyBudget)} neurons`
    },
    lastDays: [...days].map((day) => ({
      date: String(day.day),
      chatTurns: count(day.turns),
      neurons: count(day.neurons),
      meteredModelCost: cost(day.cost)
    })),
    limits: [
      "The cost is at list price, before Cloudflare's free daily allocation, which is shared across the whole account. The amount actually billed can be lower.",
      "This is the assistant's own meter, not the invoice. The invoice does not separate the assistant's charges.",
      "Only model calls are metered. The assistant's Worker, Durable Object and Workflow usage is not included."
    ],
    priceSource: `${LLAMA_3_3_PRICE.source} (checked ${LLAMA_3_3_PRICE.checkedOn})`
  };
}

export type CostReport = ReturnType<typeof readCostReport>;

/** One sentence on the assistant's own model usage in a period. */
export function describeOwnUsage(sql: Sql, period: BillingPeriod): string {
  const row = first(
    sql.exec(
      "SELECT SUM(cost_micros) AS cost, SUM(neurons) AS neurons FROM self_usage WHERE at >= ? AND at < ?",
      period.start,
      period.end
    )
  );
  return `This assistant's own model usage in the period: ${count(row.neurons)} neurons, ${cost(row.cost)} at list price before the free daily allocation. Metered by the assistant, not taken from the invoice.`;
}

export type TurnUsage = Readonly<{
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  steps: number;
}>;

/** Writes one meter row for a chat turn. Nothing is estimated (UC-8). */
export function recordTurn(
  sql: Sql,
  usage: TurnUsage,
  model: string,
  today: IsoDate
): void {
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
    sql.exec(
      `INSERT INTO self_usage
        (at, model, steps, input_tokens, output_tokens, neurons, cost_micros, metered)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      at,
      model,
      usage.steps,
      turn.inputTokens,
      turn.outputTokens,
      turn.neurons,
      turn.costMicros
    );
  } else {
    sql.exec(
      "INSERT INTO self_usage (at, model, steps, metered) VALUES (?, ?, ?, 0)",
      at,
      model,
      usage.steps
    );
  }
  bumpDailyCounter(sql, today, "chat_turns");
}

/** Counts one event of the day: a chat turn or a turn refused over budget. */
export function bumpDailyCounter(
  sql: Sql,
  today: IsoDate,
  counter: "chat_turns" | "refused_turns"
): void {
  sql.exec(
    `INSERT INTO self_activity_daily (day, ${counter}) VALUES (?, 1)
     ON CONFLICT (day) DO UPDATE SET ${counter} = ${counter} + 1`,
    today
  );
}

export function readNeuronsToday(sql: Sql, today: IsoDate): number {
  const row = first(
    sql.exec(
      "SELECT SUM(neurons) AS total FROM self_usage WHERE at >= ?",
      today
    )
  );
  return Number(row.total ?? 0);
}

/** The month's metered cost and unmetered turn count, for the UI footer. */
export function readMonthCost(
  sql: Sql,
  today: IsoDate
): { costMicros: number; unmeteredTurns: number } {
  const row = first(
    sql.exec(
      `SELECT SUM(cost_micros) AS cost,
        COALESCE(SUM(CASE WHEN metered = 0 THEN 1 ELSE 0 END), 0) AS unmetered
       FROM self_usage WHERE at >= ?`,
      `${today.slice(0, 7)}-01`
    )
  );
  return {
    costMicros: Number(row.cost ?? 0),
    unmeteredTurns: Number(row.unmetered ?? 0)
  };
}

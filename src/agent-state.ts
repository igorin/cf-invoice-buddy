import type { Dataset } from "./db/usage-store";
import type { ALLOWANCE_SOURCE, Plan } from "./domain/allowances";
import type { ScenarioId } from "./domain/scenarios";
import type { UsageSummary } from "./domain/usage-summary";

/** The agent's synced state and the views built from it. */

export type SelfCost = Readonly<{
  monthCostMicros: number;
  windowNeurons: number;
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

export const INITIAL_STATE: AgentState = {
  selfCost: {
    monthCostMicros: 0,
    windowNeurons: 0,
    dailyBudgetNeurons: 0,
    unmeteredTurns: 0
  },
  dataMode: { dataset: "live" },
  lastSyncAt: null
};

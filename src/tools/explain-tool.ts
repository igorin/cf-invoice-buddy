import { CANNOT_EXPLAIN } from "../domain/grounding";
import type { ExplanationView } from "../services/explain-service";

/**
 * Shapes a bill explanation for the model. The explanation's figures are
 * already text. This adds the dataset notice (rule G-9) and, per outcome,
 * the one thing the reply must do (rules G-2 and G-4).
 */

const INSTRUCTION: Record<ExplanationView["outcome"], string> = {
  explained:
    "State the findings as the causes, each with its evidence. State no other cause, no speculation and no link. If unexplained is not $0.00, say that amount is not explained by the account's data.",
  none_found: `No cause was found in the account's data. Give the breakdown as plain figures, without words such as because, due to, likely or probably. You may call searchCloudflareDocs once; if a page describes a cause, state it as speculation with its link. Otherwise say exactly: "${CANNOT_EXPLAIN}" Never suggest a reason of your own.`,
  no_baseline:
    "There is nothing to compare with. Give the figures for the month and ask the owner which month to compare against. Do not describe the bill as higher or lower than usual.",
  no_charges:
    "Say there are no charges to explain, and that the usage summary shows what was used."
};

export function describeForModel(view: ExplanationView) {
  return {
    dataset: view.dataset,
    notice:
      view.dataset === "test"
        ? `TEST DATA from scenario "${view.scenario}". Say so whenever you state a figure from this result.`
        : "Live account data.",
    instruction: INSTRUCTION[view.outcome],
    outcome: view.outcome,
    month: view.period.start.slice(0, 7),
    partial: view.partial,
    total: view.total,
    baseline: view.baseline,
    services: view.services,
    findings: view.findings,
    unexplained: view.unexplained,
    notes: view.notes,
    assistantOwnUsage: view.assistantOwnUsage,
    // The daily series is drawn by the breakdown card; the model gets the
    // movers' names only, which keeps the result small.
    dailyShownInCard: view.daily.map((series) => series.service)
  };
}

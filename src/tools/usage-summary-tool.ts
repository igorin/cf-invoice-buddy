import type { UsageSummaryView } from "../agent";

/**
 * Shapes the usage summary for the model. Every figure is already a string,
 * so the model copies and never formats or computes (rule G-1). The result
 * always says which dataset it came from (rule G-9).
 */

const quantity = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

const percent = (share: number): string => `${(share * 100).toFixed(1)}%`;

export function describeSummaryForModel(view: UsageSummaryView) {
  return {
    dataset: view.dataset,
    notice:
      view.dataset === "test"
        ? `TEST DATA from scenario "${view.scenario}". Say so whenever you state a figure from this result.`
        : "Live account data.",
    period: `${view.period.start} up to, not including, ${view.period.end}`,
    lastSynced: view.lastSyncAt ?? "not applicable",
    charges:
      view.billing.status === "none"
        ? "No charges: this account has no usage-based subscription and no invoices."
        : view.billing.status === "costed"
          ? "Billed amounts are listed per row."
          : `Billed amounts are unavailable: ${view.billing.reason}`,
    rows: view.rows.map((row) => ({
      product: row.service,
      metric: row.metric,
      usedThisPeriod: `${quantity(row.quantity)} ${row.unit}`,
      usedToday: `${quantity(row.today)} ${row.unit}`,
      includedAllowance: row.allowance
        ? `${quantity(row.allowance.amount)} ${row.unit} per ${row.allowance.per}`
        : "none listed",
      allowanceUsed: row.allowance
        ? percent(row.allowance.share)
        : "not applicable",
      billed:
        row.billed.status === "amount"
          ? row.billed.text
          : row.billed.status === "none"
            ? "no charges"
            : "unavailable"
    })),
    unavailableProducts: view.unavailable.map(
      (entry) => `${entry.service}: usage could not be read (${entry.reason})`
    )
  };
}

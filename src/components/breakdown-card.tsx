/**
 * The bill breakdown card (spec UC-1, UC-2), drawn from the explainBillChange
 * tool result. These are the grounded facts: they come from the tool, not
 * from the model's wording.
 */

type Direction = "higher" | "lower" | "same" | null;

type Breakdown = {
  dataset: "live" | "test";
  outcome: "no_charges" | "no_baseline" | "explained" | "none_found";
  month: string;
  partial: boolean;
  total: string;
  baseline: {
    months: string[];
    total: string;
    difference: string;
    direction: Exclude<Direction, null>;
    percent: string | null;
  } | null;
  services: Array<{
    service: string;
    current: string;
    usual: string | null;
    difference: string | null;
    direction: Direction;
  }>;
  findings: Array<{
    statement: string;
    impact: string;
    evidence: Array<{ date: string; quantity: string; cost: string }>;
  }>;
  unexplained: string | null;
  notes: string[];
  assistantOwnUsage: string | null;
};

function isBreakdown(value: unknown): value is Breakdown {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<Breakdown>;
  return (
    typeof candidate.total === "string" &&
    typeof candidate.outcome === "string" &&
    Array.isArray(candidate.services) &&
    Array.isArray(candidate.findings) &&
    Array.isArray(candidate.notes)
  );
}

const ARROW: Record<Exclude<Direction, null>, string> = {
  higher: "▲",
  lower: "▼",
  same: "="
};

function Change({
  amount,
  direction
}: {
  amount: string | null;
  direction: Direction;
}) {
  if (amount === null || direction === null) {
    return <span className="text-kumo-subtle">No comparison</span>;
  }
  return (
    <span>
      <span aria-hidden="true">{ARROW[direction]} </span>
      {amount} {direction === "same" ? "" : direction}
    </span>
  );
}

const OUTCOME_LINE: Record<Breakdown["outcome"], string> = {
  explained: "Causes found in the account's data:",
  none_found: "No cause was found in the account's data.",
  no_baseline: "There is no earlier month to compare with.",
  no_charges: "There are no charges to explain."
};

export function BreakdownCard({ output }: { output: unknown }) {
  if (!isBreakdown(output)) return null;
  const view = output;
  return (
    <section
      aria-label={`Bill breakdown for ${view.month}`}
      className="max-w-[95%] px-4 py-3 rounded-xl ring ring-kumo-line bg-kumo-base text-sm text-kumo-default space-y-3"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">
          {view.month}: {view.total}
          {view.partial ? " so far" : ""}
        </h3>
        {view.dataset === "test" && (
          <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-950">
            Test data
          </span>
        )}
        {view.baseline && (
          <span className="text-kumo-subtle">
            usual {view.baseline.total} ({view.baseline.months.join(", ")});{" "}
            <Change
              amount={view.baseline.difference}
              direction={view.baseline.direction}
            />
            {view.baseline.percent ? `, ${view.baseline.percent}` : ""}
          </span>
        )}
      </header>

      {view.services.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-xs text-kumo-subtle">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Product
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  This month
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Usual
                </th>
                <th scope="col" className="py-1 font-medium">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {view.services.map((row) => (
                <tr key={row.service} className="border-t border-kumo-line">
                  <th scope="row" className="py-1 pr-3 font-normal">
                    {row.service}
                  </th>
                  <td className="py-1 pr-3">{row.current}</td>
                  <td className="py-1 pr-3">{row.usual ?? "–"}</td>
                  <td className="py-1">
                    <Change amount={row.difference} direction={row.direction} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <p className="font-medium">{OUTCOME_LINE[view.outcome]}</p>
        {view.findings.length > 0 && (
          <ul className="mt-1 space-y-2 list-disc pl-5">
            {view.findings.map((finding) => (
              <li key={finding.statement}>
                {finding.statement}
                {finding.evidence.length > 0 && (
                  <ul className="mt-0.5 text-xs text-kumo-subtle">
                    {finding.evidence.map((item) => (
                      <li key={item.date}>
                        {item.date}: {item.quantity}, {item.cost}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {view.unexplained !== null && view.outcome !== "no_charges" && (
          <p className="mt-1 text-kumo-subtle">
            Not explained by the account's data: {view.unexplained}
          </p>
        )}
      </div>

      {(view.notes.length > 0 || view.assistantOwnUsage) && (
        <footer className="text-xs text-kumo-subtle space-y-0.5">
          {view.notes.map((note) => (
            <p key={note}>{note}</p>
          ))}
          {view.assistantOwnUsage && <p>{view.assistantOwnUsage}</p>}
        </footer>
      )}
    </section>
  );
}

const MICROS_PER_USD = 1_000_000;
const WARN_SHARE = 0.8;

type SelfCost = {
  monthCostMicros: number;
  windowNeurons: number;
  dailyBudgetNeurons: number;
  unmeteredTurns: number;
};

/** The assistant's own running cost (spec UC-8), from synced agent state. */
export function CostFooter({ cost }: { cost: SelfCost | undefined }) {
  if (!cost) return null;
  const share =
    cost.dailyBudgetNeurons > 0
      ? cost.windowNeurons / cost.dailyBudgetNeurons
      : 0;
  const dollars = (cost.monthCostMicros / MICROS_PER_USD).toFixed(4);
  return (
    <p
      className={`text-xs text-center ${share >= WARN_SHARE ? "text-amber-700 font-medium" : "text-kumo-subtle"}`}
      title="At list price, before Cloudflare's free daily allocation, which is shared across the account. Model calls only. This is the assistant's meter, not the invoice."
    >
      This assistant: ${dollars} of model usage this month at list price ·{" "}
      {Math.round(cost.windowNeurons).toLocaleString("en-US")} of{" "}
      {cost.dailyBudgetNeurons.toLocaleString("en-US")} neurons of the 24-hour
      budget
      {share >= 1 ? " · budget reached" : ""}
      {cost.unmeteredTurns > 0
        ? ` · ${cost.unmeteredTurns} unmetered turn(s)`
        : ""}
    </p>
  );
}

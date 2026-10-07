/**
 * The plan comparison card (spec UC-7), drawn from the comparePlans tool
 * result. Every amount is an estimate at list price and is labelled as one.
 */

type Line = {
  service: string;
  metric: string;
  used: string;
  included: string;
  billable: string;
  rate: string;
  cost: string;
};

type Estimate = {
  plan: "free" | "paid";
  name: string;
  total: string;
  base: string;
  lines: Line[];
  overLimit: Array<{
    service: string;
    metric: string;
    limit: string;
    daysOver: number;
  }>;
};

type Comparison = {
  dataset: "live" | "test";
  month: string;
  partial: boolean;
  currentPlan: "free" | "paid";
  plans: Estimate[];
  verdict: string;
  notPriced: Array<{ service: string; metric: string }>;
  notMeasured: string[];
  notes: string[];
  priceSource: { checkedOn: string; urls: string[] };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isComparison(value: unknown): value is Comparison {
  return (
    isRecord(value) &&
    typeof value.month === "string" &&
    typeof value.verdict === "string" &&
    Array.isArray(value.plans) &&
    Array.isArray(value.notPriced) &&
    Array.isArray(value.notMeasured) &&
    Array.isArray(value.notes) &&
    isRecord(value.priceSource)
  );
}

/** True when a tool result is a plan comparison. */
export const hasPlanComparison = (output: unknown): boolean =>
  isComparison(output);

function PlanTable({ estimate }: { estimate: Estimate }) {
  return (
    <div className="space-y-1">
      <h4 className="font-semibold">
        {estimate.name}: estimated {estimate.total}
      </h4>
      {estimate.plan === "paid" && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-xs text-kumo-subtle">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Product
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Used
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Included
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Beyond
                </th>
                <th scope="col" className="py-1 font-medium">
                  Estimate
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-0.5 pr-3" colSpan={4}>
                  Monthly price
                </td>
                <td className="py-0.5">{estimate.base}</td>
              </tr>
              {estimate.lines.map((line) => (
                <tr key={`${line.service} ${line.metric}`}>
                  <td className="py-0.5 pr-3">
                    {line.service} {line.metric}
                  </td>
                  <td className="py-0.5 pr-3">{line.used}</td>
                  <td className="py-0.5 pr-3">{line.included}</td>
                  <td className="py-0.5 pr-3">
                    {line.billable}
                    <span className="text-kumo-subtle"> at {line.rate}</span>
                  </td>
                  <td className="py-0.5">{line.cost}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {estimate.plan === "free" &&
        (estimate.overLimit.length === 0 ? (
          <p>The period's usage stays inside every daily limit.</p>
        ) : (
          <ul className="list-disc pl-5">
            {estimate.overLimit.map((item) => (
              <li key={`${item.service} ${item.metric}`}>
                {item.service} {item.metric} passed {item.limit} on{" "}
                {item.daysOver} day{item.daysOver === 1 ? "" : "s"}. Usage
                beyond a limit fails; it is not billed.
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export function PlanCard({ output }: { output: unknown }) {
  if (!isComparison(output)) return null;
  const view = output;
  return (
    <section
      aria-label={`Plan comparison for ${view.month}`}
      className="max-w-[95%] px-4 py-3 rounded-xl ring ring-kumo-line bg-kumo-base text-sm text-kumo-default space-y-3"
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">
          Plan comparison for {view.month}
          {view.partial ? " so far" : ""}
        </h3>
        <span className="px-1.5 py-0.5 text-xs rounded bg-kumo-tint">
          Estimate at list price
        </span>
        {view.dataset === "test" && (
          <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-950">
            Test data
          </span>
        )}
      </header>
      <p>{view.verdict}</p>
      {view.plans.map((estimate) => (
        <PlanTable key={estimate.plan} estimate={estimate} />
      ))}
      {view.notPriced.length > 0 && (
        <p>
          Left out of the totals, because the price table does not cover it:{" "}
          {view.notPriced
            .map((item) => `${item.service} ${item.metric}`)
            .join(", ")}
          .
        </p>
      )}
      <p className="text-kumo-subtle">
        Not in the account's usage data, so not counted:{" "}
        {view.notMeasured.join(", ")}.
      </p>
      {view.notes.map((note) => (
        <p key={note} className="text-kumo-subtle">
          {note}
        </p>
      ))}
      <p className="text-kumo-subtle">
        Prices read from Cloudflare's pricing pages on or after{" "}
        {view.priceSource.checkedOn}.
      </p>
    </section>
  );
}

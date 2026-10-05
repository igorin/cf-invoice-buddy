import { useEffect, useState } from "react";
import type { AgentState, DataMode, UsageSummaryView } from "../agent";
import { SCENARIOS } from "../domain/scenarios";

/**
 * The usage summary panel, the data-mode switch and the test-mode banner
 * (spec UC-9, UC-10). None of this goes through the model: the panel shows
 * what the agent's getUsageSummary method returns.
 */

type AgentCalls = Readonly<{
  getUsageSummary: () => Promise<UsageSummaryView>;
  setDataMode: (dataset: string, scenario?: string) => Promise<DataMode>;
}>;

type Load =
  | { status: "loading" }
  | { status: "ready"; view: UsageSummaryView }
  | { status: "error" };

const quantity = (value: number): string =>
  value.toLocaleString("en-US", { maximumFractionDigits: 2 });

const WARN_SHARE = 0.8;

function scenarioTitle(mode: DataMode): string | null {
  if (mode.dataset !== "test") return null;
  return SCENARIOS.find((s) => s.id === mode.scenario)?.title ?? mode.scenario;
}

export function TestModeBanner({ mode }: { mode: DataMode }) {
  const title = scenarioTitle(mode);
  if (title === null) return null;
  return (
    <output className="block px-5 py-2 text-sm font-medium text-center bg-amber-100 text-amber-950 border-b border-amber-300">
      Test mode: {title}. Figures are fixture data.
    </output>
  );
}

export function DataModeSwitch({
  mode,
  calls
}: {
  mode: DataMode;
  calls: AgentCalls;
}) {
  const [busy, setBusy] = useState(false);
  const value = mode.dataset === "test" ? mode.scenario : "live";
  return (
    <label className="flex items-center gap-1.5 text-xs text-kumo-subtle">
      Data
      <select
        className="px-2 py-1 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default"
        value={value}
        disabled={busy}
        onChange={(event) => {
          const choice = event.target.value;
          setBusy(true);
          const change =
            choice === "live"
              ? calls.setDataMode("live")
              : calls.setDataMode("test", choice);
          change
            .catch((error: unknown) =>
              console.error("Could not switch data mode:", error)
            )
            .finally(() => setBusy(false));
        }}
      >
        <option value="live">Live account</option>
        {SCENARIOS.map((scenario) => (
          <option key={scenario.id} value={scenario.id}>
            Test: {scenario.title}
          </option>
        ))}
      </select>
    </label>
  );
}

function Billed({ row }: { row: UsageSummaryView["rows"][number] }) {
  if (row.billed.status === "amount") return <>{row.billed.text}</>;
  if (row.billed.status === "none") return <>No charge</>;
  return <span className="text-kumo-subtle">Unavailable</span>;
}

function Allowance({ row }: { row: UsageSummaryView["rows"][number] }) {
  if (!row.allowance)
    return <span className="text-kumo-subtle">None listed</span>;
  const percent = Math.min(row.allowance.share * 100, 100);
  const warn = row.allowance.share >= WARN_SHARE;
  return (
    <div>
      <div>
        {quantity(row.allowance.used)} of {quantity(row.allowance.amount)} per{" "}
        {row.allowance.per}
      </div>
      <progress
        className={`w-full h-1.5 ${warn ? "accent-amber-600" : "accent-emerald-600"}`}
        max={100}
        value={percent}
        aria-label={`${row.service} ${row.metric}: ${percent.toFixed(1)}% of the included allowance used`}
      />
    </div>
  );
}

function SummaryTable({ view }: { view: UsageSummaryView }) {
  if (view.rows.length === 0) {
    return (
      <p className="text-sm text-kumo-subtle">No usage recorded this period.</p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm text-left text-kumo-default">
        <thead className="text-xs text-kumo-subtle">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Product
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Used this period
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Included allowance
            </th>
            <th scope="col" className="py-1 font-medium">
              Billed
            </th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => (
            <tr
              key={`${row.service}/${row.metric}`}
              className="border-t border-kumo-line align-top"
            >
              <th scope="row" className="py-1.5 pr-3 font-normal">
                {row.service}
                <span className="block text-xs text-kumo-subtle">
                  {row.metric}
                </span>
              </th>
              <td className="py-1.5 pr-3">
                {quantity(row.quantity)} {row.unit}
              </td>
              <td className="py-1.5 pr-3">
                <Allowance row={row} />
              </td>
              <td className="py-1.5">
                <Billed row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Footer({ view }: { view: UsageSummaryView }) {
  const charges =
    view.billing.status === "none"
      ? "No charges: this account has no usage-based subscription and no invoices."
      : view.billing.status === "unavailable"
        ? `Billed amounts are unavailable: ${view.billing.reason}`
        : null;
  return (
    <div className="mt-2 space-y-1 text-xs text-kumo-subtle">
      {view.unavailable.map((entry) => (
        <p key={entry.service}>
          {entry.service}: usage could not be read ({entry.reason}).
        </p>
      ))}
      {charges && <p>{charges}</p>}
      <p>
        Period {view.period.start} to {view.period.end}, not including the last
        date.{" "}
        {view.dataset === "test"
          ? "Fixture data."
          : `Last synced ${view.lastSyncAt ?? "never"}.`}{" "}
        Allowances checked {view.allowanceSource.checkedOn}.
      </p>
    </div>
  );
}

export function UsagePanel({
  state,
  calls,
  connected
}: {
  state: AgentState | null;
  calls: AgentCalls;
  connected: boolean;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const mode = state?.dataMode;
  const modeKey = mode ? JSON.stringify(mode) : "";
  const syncedAt = state?.lastSyncAt ?? "";

  // Reload when connected, when the mode changes and after each sync.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    calls
      .getUsageSummary()
      .then((view) => {
        if (!cancelled) setLoad({ status: "ready", view });
      })
      .catch(() => {
        if (!cancelled) setLoad({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
    // `calls` is a fresh object each render; the keys below are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, modeKey, syncedAt]);

  return (
    <section
      aria-labelledby="usage-summary-heading"
      className="px-5 py-3 bg-kumo-base border-b border-kumo-line"
    >
      <details open className="max-w-3xl mx-auto">
        <summary
          id="usage-summary-heading"
          className="text-sm font-semibold text-kumo-default cursor-pointer"
        >
          Usage this period
          {load.status === "ready" && load.view.dataset === "test" && (
            <span className="ml-2 px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-950">
              Test data
            </span>
          )}
        </summary>
        <div className="mt-2">
          {load.status === "loading" && (
            <output className="text-sm text-kumo-subtle">Loading usage…</output>
          )}
          {load.status === "error" && (
            <p role="alert" className="text-sm text-kumo-danger">
              The usage summary could not be loaded.
            </p>
          )}
          {load.status === "ready" && (
            <>
              <SummaryTable view={load.view} />
              <Footer view={load.view} />
            </>
          )}
        </div>
      </details>
    </section>
  );
}

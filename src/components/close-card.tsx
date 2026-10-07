/**
 * Invoice close cards (spec UC-6). The approval card is drawn from the
 * agent's synced state and is the only place a close can be approved or
 * rejected (NFR-S3): the buttons call the agent directly, not the model.
 * The close card shows what the close tools returned.
 */
import { useState } from "react";
import type { AgentState } from "../agent";
import type { CloseView, DecisionResult } from "../services/close-service";

type CloseCalls = Readonly<{
  decideClose: (
    workflowId: string,
    approved: boolean,
    reason?: string
  ) => Promise<DecisionResult>;
}>;

const CARD =
  "px-4 py-3 rounded-xl ring ring-kumo-line bg-kumo-base text-sm text-kumo-default space-y-3";

function TestBadge() {
  return (
    <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-950">
      Test data. No real period is closed.
    </span>
  );
}

type Figures = Readonly<{
  total: string | null | undefined;
  lineItems: ReadonlyArray<Readonly<{ service: string; amount: string }>>;
  reconciliation: string | null | undefined;
  findings: ReadonlyArray<string>;
  unexplained: string | null | undefined;
  notes: ReadonlyArray<string>;
}>;

function CloseFigures({ figures }: { figures: Figures }) {
  return (
    <>
      {figures.lineItems.length > 0 && (
        <table className="w-full text-left">
          <thead className="text-xs text-kumo-subtle">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Product
              </th>
              <th scope="col" className="py-1 font-medium">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {figures.lineItems.map((line) => (
              <tr key={line.service}>
                <td className="py-0.5 pr-3">{line.service}</td>
                <td className="py-0.5">{line.amount}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="py-0.5 pr-3">Total</td>
              <td className="py-0.5">{figures.total}</td>
            </tr>
          </tbody>
        </table>
      )}
      {figures.reconciliation && <p>{figures.reconciliation}</p>}
      {figures.findings.length > 0 ? (
        <div>
          <h4 className="font-semibold">Found in the period's usage</h4>
          <ul className="list-disc pl-5">
            {figures.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </div>
      ) : (
        figures.total && <p>No anomaly was found in the period's usage.</p>
      )}
      {figures.unexplained && figures.unexplained !== "$0.00" && (
        <p>Not explained by the account's data: {figures.unexplained}</p>
      )}
      {figures.notes.map((note) => (
        <p key={note} className="text-kumo-subtle">
          {note}
        </p>
      ))}
    </>
  );
}

function ApprovalCard({
  close,
  calls
}: {
  close: CloseView;
  calls: CloseCalls;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const summary = close.summary;
  const decide = (approved: boolean) => {
    setBusy(true);
    setProblem(null);
    calls
      .decideClose(close.workflowId, approved, reason.trim() || undefined)
      .then((result) => {
        if (result.status === "not_pending") {
          setProblem("This close is no longer waiting for a decision.");
        }
      })
      .catch(() => setProblem("The decision could not be recorded. Try again."))
      .finally(() => setBusy(false));
  };
  const reasonId = `close-reason-${close.workflowId}`;
  return (
    <section
      aria-label={`Approve the invoice close for ${close.month}`}
      className={`${CARD} ring-2 ring-kumo-warning`}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">
          Invoice close for {close.month}: your approval is needed
        </h3>
        {close.testData && <TestBadge />}
      </header>
      <CloseFigures
        figures={{
          total: summary?.total,
          lineItems: summary?.lineItems ?? [],
          reconciliation: summary?.reconciliation?.statement,
          findings: (summary?.findings ?? []).map((item) => item.statement),
          unexplained: summary?.unexplained,
          notes: summary?.notes ?? []
        }}
      />
      <p className="text-kumo-subtle">
        Approving closes the period for good: its figures can no longer change.
        Rejecting leaves it open.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={reasonId} className="flex-1 min-w-48 text-xs">
          Reason (optional)
          <input
            id={reasonId}
            type="text"
            value={reason}
            maxLength={500}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            className="block w-full mt-1 px-2 py-1 text-sm rounded border border-kumo-line bg-kumo-base"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(true)}
          className="px-3 py-1.5 rounded bg-kumo-brand text-white disabled:opacity-50"
        >
          Approve and close {close.month}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => decide(false)}
          className="px-3 py-1.5 rounded ring ring-kumo-line disabled:opacity-50"
        >
          Reject
        </button>
      </div>
      <output aria-live="polite" className="block text-kumo-danger">
        {problem}
      </output>
    </section>
  );
}

/** One approval card for each close waiting for the owner. */
export function ApprovalCards({
  state,
  calls
}: {
  state: AgentState | null;
  calls: CloseCalls;
}) {
  const pending = state?.pendingApprovals ?? [];
  if (pending.length === 0) return null;
  return (
    <div className="px-5 py-3 space-y-3 border-b border-kumo-line max-h-[45vh] overflow-y-auto shrink-0">
      {pending.map((close) => (
        <ApprovalCard key={close.workflowId} close={close} calls={calls} />
      ))}
    </div>
  );
}

type ToolClose = Figures &
  Readonly<{
    month: string;
    state: string;
    startedOn: string;
    closedOn: string | null;
    ownersReason: string | null;
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isToolClose = (value: unknown): value is ToolClose =>
  isRecord(value) &&
  typeof value.month === "string" &&
  typeof value.state === "string" &&
  Array.isArray(value.lineItems) &&
  Array.isArray(value.findings) &&
  Array.isArray(value.notes);

function closesIn(output: unknown): ToolClose[] {
  if (!isRecord(output)) return [];
  if (Array.isArray(output.closes)) return output.closes.filter(isToolClose);
  return isToolClose(output.close) ? [output.close] : [];
}

/** True when a tool result holds at least one close to show. */
export const hasClose = (output: unknown): boolean =>
  closesIn(output).length > 0;

/** Draws the result of startInvoiceClose or getInvoiceCloses. */
export function CloseCard({ output }: { output: unknown }) {
  const closes = closesIn(output);
  if (!isRecord(output) || closes.length === 0) return null;
  const testData =
    typeof output.notice === "string" && output.notice.startsWith("TEST DATA");
  return (
    <section aria-label="Invoice closes" className={`max-w-[95%] ${CARD}`}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">
          {closes.length === 1 ? "Invoice close" : "Invoice closes"}
        </h3>
        {testData && <TestBadge />}
      </header>
      {closes.map((close) => (
        <details key={close.month} open={closes.length === 1}>
          <summary className="cursor-pointer">
            <span className="font-semibold">{close.month}</span>{" "}
            <span className="text-kumo-subtle">{close.state}</span>
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-kumo-subtle">
              Started {close.startedOn}
              {close.closedOn ? `; closed ${close.closedOn}` : ""}
              {close.ownersReason
                ? `. Owner's reason: ${close.ownersReason}`
                : ""}
            </p>
            <CloseFigures figures={close} />
          </div>
        </details>
      ))}
    </section>
  );
}

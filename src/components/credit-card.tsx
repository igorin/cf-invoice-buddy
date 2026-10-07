/**
 * Credit request cards (spec UC-3, UC-4), drawn from the results of the
 * credit tools. The draft, its state and the submission steps come from the
 * tool, not from the model's wording. Nothing here submits anything.
 */
import { useState } from "react";

type Request = {
  id: string;
  month: string;
  service: string;
  amountRequested: string;
  basis: string;
  state: string;
  amountReportedByOwner: string | null;
  noteReportedByOwner: string | null;
  writtenAt: string;
  draft: string;
};

type Submission = {
  steps: string[];
  url: string;
  checkedOn: string;
  note: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isRequest = (value: unknown): value is Request =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.draft === "string" &&
  typeof value.service === "string" &&
  typeof value.state === "string";

const isSubmission = (value: unknown): value is Submission =>
  isRecord(value) &&
  Array.isArray(value.steps) &&
  typeof value.url === "string" &&
  // Only Cloudflare's own documentation is ever linked (G-7).
  value.url.startsWith("https://developers.cloudflare.com/");

const CARD =
  "max-w-[95%] px-4 py-3 rounded-xl ring ring-kumo-line bg-kumo-base text-sm text-kumo-default space-y-3";

function TestBadge() {
  return (
    <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-amber-950">
      Test data. Do not submit.
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="px-2 py-1 text-xs rounded ring ring-kumo-line hover:bg-kumo-tint"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : "Copy draft"}</span>
    </button>
  );
}

function Draft({ request, open }: { request: Request; open: boolean }) {
  return (
    <details open={open} className="space-y-2">
      <summary className="cursor-pointer">
        <span className="font-semibold">
          {request.service}, {request.month}
        </span>{" "}
        <span className="text-kumo-subtle">
          requested: {request.amountRequested} · written {request.writtenAt}
        </span>
      </summary>
      <p>
        {request.state}
        {request.amountReportedByOwner
          ? ` Amount, as reported by the account owner: ${request.amountReportedByOwner}.`
          : ""}
        {request.noteReportedByOwner
          ? ` Owner's note: ${request.noteReportedByOwner}`
          : ""}
      </p>
      <p className="text-kumo-subtle">Basis: {request.basis}.</p>
      <pre className="p-3 rounded bg-kumo-tint whitespace-pre-wrap break-words font-mono text-xs">
        {request.draft}
      </pre>
      <CopyButton text={request.draft} />
    </details>
  );
}

function HowToSubmit({ submission }: { submission: Submission }) {
  return (
    <div className="space-y-1">
      <h4 className="font-semibold">How to submit it yourself</h4>
      <ol className="list-decimal pl-5 space-y-0.5">
        {submission.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-kumo-subtle">{submission.note}</p>
      <p>
        <a
          href={submission.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Cloudflare: contacting support
        </a>{" "}
        <span className="text-kumo-subtle">
          (steps checked {submission.checkedOn})
        </span>
      </p>
    </div>
  );
}

function requestsIn(output: unknown): Request[] {
  if (!isRecord(output)) return [];
  if (Array.isArray(output.requests)) return output.requests.filter(isRequest);
  return isRequest(output.request) ? [output.request] : [];
}

/** True when a tool result holds at least one draft to show. */
export const hasCreditDraft = (output: unknown): boolean =>
  requestsIn(output).length > 0;

/**
 * Draws the result of draftCreditRequest, getCreditRequests or
 * recordCreditOutcome. Returns null for a result with no draft in it, which
 * the caller then shows as plain tool output.
 */
export function CreditCard({ output }: { output: unknown }) {
  const requests = requestsIn(output);
  if (!isRecord(output) || requests.length === 0) return null;
  const testData =
    typeof output.notice === "string" && output.notice.startsWith("TEST DATA");
  const single = !Array.isArray(output.requests);
  const title =
    output.status === "existing"
      ? "Existing credit request draft (unchanged)"
      : output.status === "recorded"
        ? "Credit request: outcome recorded"
        : single
          ? "Credit request draft"
          : "Credit request drafts";
  return (
    <section aria-label={title} className={CARD}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">{title}</h3>
        {testData && <TestBadge />}
        <span className="text-kumo-subtle">
          Not submitted by this assistant
        </span>
      </header>
      {requests.map((request) => (
        <Draft key={request.id} request={request} open={single} />
      ))}
      {isSubmission(output.submission) && (
        <HowToSubmit submission={output.submission} />
      )}
    </section>
  );
}

import { tool } from "ai";
import { z } from "zod";
import type { InvoiceBuddyAgent } from "../agent";
import type { CloseView, StartResult } from "../services/close-service";

/**
 * Invoice close tools (spec UC-6). The model can start a close and read
 * closes. It cannot approve, reject or finalize one: that needs the owner's
 * button in the approval card (NFR-S3), and no tool here reaches it.
 */

const OWNER_DECIDES =
  "Only the owner can approve or reject, with the buttons in the approval card. You cannot, and must never say you approved, closed or finalized a period.";

const notice = (testData: boolean): string =>
  testData
    ? "TEST DATA. This close is of fixture data and closes no real period."
    : "Live account data.";

/** A close as the model and the close card see it. */
export function describeClose(close: CloseView) {
  const summary = close.summary;
  return {
    month: close.month,
    state: close.stateInWords,
    total: summary?.total ?? null,
    lineItems: summary?.lineItems ?? [],
    reconciliation: summary?.reconciliation?.statement ?? null,
    findings: (summary?.findings ?? []).map((finding) => finding.statement),
    unexplained: summary?.unexplained ?? null,
    notes: summary?.notes ?? [],
    startedOn: close.startedAt.slice(0, 10),
    closedOn: close.closedAt?.slice(0, 10) ?? null,
    ownersReason: close.decidedReason
  };
}

const START_INSTRUCTION: Record<StartResult["status"], string> = {
  started: `The close has started. It freezes the period's usage, totals it and checks it, then waits for the owner. A summary with Approve and Reject buttons appears above the chat when it is ready. Say this. ${OWNER_DECIDES}`,
  open_period:
    "That period has not ended, so it cannot be closed yet. Say so and name the month.",
  already_closed:
    "That period is already closed and its figures are final. Say so. It cannot be closed again.",
  in_progress: `A close of that period is already under way. Give its state exactly as stated. ${OWNER_DECIDES}`
};

export function describeStartForModel(result: StartResult, testData: boolean) {
  return {
    status: result.status,
    notice: notice(testData),
    instruction: START_INSTRUCTION[result.status],
    close: result.close ? describeClose(result.close) : null,
    ...(result.status === "started" ? {} : { month: result.month })
  };
}

export function describeClosesForModel(
  closes: ReadonlyArray<CloseView>,
  testData: boolean
) {
  return {
    notice: notice(testData),
    instruction:
      closes.length === 0
        ? "No invoice close has been started. Say so."
        : `Give each close's state exactly as stated. A period is closed only if its state says Closed. ${OWNER_DECIDES}`,
    closes: closes.map(describeClose)
  };
}

export function buildCloseTools(agent: InvoiceBuddyAgent) {
  const testData = () => agent.state.dataMode.dataset === "test";
  return {
    startInvoiceClose: tool({
      description:
        "Start the monthly invoice close for a finished month: freeze its usage, total it, check it, then wait for the owner's approval. Use when the owner asks to close a month. It does not approve or finalize.",
      // Loose for the same reason as explainBillChange: see tools/index.ts.
      inputSchema: z.object({
        month: z
          .string()
          .nullish()
          .describe("YYYY-MM. Omit for the last finished month.")
      }),
      execute: async ({ month }) =>
        describeStartForModel(
          await agent.startInvoiceClose(month ?? undefined),
          testData()
        )
    }),
    getInvoiceCloses: tool({
      description:
        "List the invoice closes and their states: waiting for approval, closed, rejected, expired or failed.",
      inputSchema: z.object({}),
      execute: async () =>
        describeClosesForModel(agent.getInvoiceCloses(), testData())
    })
  };
}

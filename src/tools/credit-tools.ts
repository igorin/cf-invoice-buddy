import { tool } from "ai";
import { z } from "zod";
import type { InvoiceBuddyAgent } from "../agent";
import { TEST_DATA_MARK } from "../domain/credit-draft";
import type {
  CreditView,
  DraftResult,
  OutcomeResult
} from "../services/credit-service";
import { MONTH_PATTERN } from "../services/explain-service";

/**
 * Credit request tools (spec UC-3, UC-4). They write only to the agent's own
 * database. None submits anything to Cloudflare, and recording an outcome
 * waits for the owner's approval, because it stores the owner's word.
 */

/** True for true, and for the text forms a model sends in its place. */
export const isYes = (value: unknown): boolean =>
  value === true ||
  (typeof value === "string" && /^(true|yes|1)$/i.test(value.trim()));

const NEVER_SUBMITS =
  "You cannot submit it and must never say it was or will be submitted by you.";

const notice = (testData: boolean): string =>
  testData ? `TEST DATA. ${TEST_DATA_MARK}` : "Live account data.";

/** A draft as the model and the draft card see it. */
function describeRequest(request: CreditView) {
  return {
    id: request.id,
    month: request.month,
    service: request.service,
    amountRequested: request.amount ?? "not stated",
    basis:
      request.basis === "account_data"
        ? "supported by the account's usage data"
        : "the account's data shows no anomaly; it rests on the owner's statement",
    state: request.stateInWords,
    amountReportedByOwner: request.reportedAmount,
    noteReportedByOwner: request.reportedNote,
    writtenAt: request.createdAt.slice(0, 10),
    draft: request.draft
  };
}

export function describeDraftForModel(result: DraftResult) {
  if (result.status === "unknown_service") {
    return {
      status: result.status,
      month: result.month,
      productsWithCharges: result.services,
      instruction:
        result.services.length === 0
          ? "There are no charges in that month, so there is nothing to request a credit for. Say so."
          : "That product has no charges in that month. Name the products listed and ask which one the owner means."
    };
  }
  const { request } = result;
  return {
    status: result.status,
    notice: notice(request.testData),
    instruction:
      result.status === "existing"
        ? `A draft for this product and month already exists and was left unchanged. Say so and ask whether to replace it. ${NEVER_SUBMITS}`
        : `The draft and the submission steps are shown to the owner in a card. Do not repeat the draft. Say it is a draft, give the amount requested exactly as stated here, give the basis, and tell the owner to submit it themselves with the steps in the card. ${NEVER_SUBMITS}`,
    request: describeRequest(request),
    submission: result.submission
  };
}

export function describeListForModel(
  requests: ReadonlyArray<CreditView>,
  testData: boolean
) {
  return {
    notice: notice(testData),
    instruction:
      requests.length === 0
        ? "No credit request has been drafted. Say so."
        : 'These are drafts this assistant wrote. Any outcome is what the owner reported, not confirmed by Cloudflare: say "as you reported" when repeating one. The drafts are shown in a card; do not repeat their text.',
    requests: requests.map(describeRequest)
  };
}

export function describeOutcomeForModel(result: OutcomeResult) {
  if (result.status !== "recorded") {
    return {
      status: result.status,
      instruction:
        result.status === "invalid_outcome"
          ? "Nothing was recorded. The outcome must be submitted, approved, partially_approved or denied."
          : result.status === "replaced"
            ? "Nothing was recorded. That draft was replaced by a later one; call getCreditRequests to find the current one."
            : "Nothing was recorded. No draft has that id; call getCreditRequests to find it."
    };
  }
  return {
    status: result.status,
    notice: notice(result.request.testData),
    instruction:
      "Recorded as the owner's report. Confirm it, and say it is what the owner reported, not confirmed by Cloudflare.",
    request: describeRequest(result.request)
  };
}

export function buildCreditTools(agent: InvoiceBuddyAgent) {
  return {
    draftCreditRequest: tool({
      description:
        "Draft a billing credit request for one product in one month, from the account's data, and store it. Use when the owner asks for a credit or refund. It submits nothing.",
      // Loose for the same reason as explainBillChange: see tools/index.ts.
      inputSchema: z.object({
        service: z.string().describe("Product name as on the bill."),
        ownerReason: z.string().describe("The owner's reason, in their words."),
        month: z.string().nullish().describe("YYYY-MM. Omit for this month."),
        // The model sends this as text ("true") as often as not.
        replaceExisting: z
          .union([z.boolean(), z.string()])
          .nullish()
          .describe("True only if the owner asked to replace the draft.")
      }),
      execute: async ({ service, ownerReason, month, replaceExisting }) => {
        const named = month?.trim();
        return describeDraftForModel(
          await agent.draftCreditRequest({
            service,
            ownerReason,
            replaceExisting: isYes(replaceExisting),
            ...(named && MONTH_PATTERN.test(named) ? { month: named } : {})
          })
        );
      }
    }),
    getCreditRequests: tool({
      description:
        "List the credit request drafts written so far, with what the owner reported about each.",
      inputSchema: z.object({}),
      execute: async () =>
        describeListForModel(
          agent.getCreditRequests(),
          agent.state.dataMode.dataset === "test"
        )
    }),
    recordCreditOutcome: tool({
      description:
        "Record what the owner says happened to a credit request. Only when the owner states it; the owner confirms before it runs.",
      inputSchema: z.object({
        id: z.string().describe("The draft's id, from getCreditRequests."),
        outcome: z
          .string()
          .describe("submitted, approved, partially_approved or denied."),
        amount: z
          .string()
          .nullish()
          .describe("Amount the owner says was credited."),
        note: z.string().nullish()
      }),
      needsApproval: true,
      execute: async ({ id, outcome, amount, note }) =>
        describeOutcomeForModel(
          agent.recordCreditOutcome({
            id,
            outcome: outcome
              .trim()
              .toLowerCase()
              .replace(/[\s-]+/g, "_"),
            amount: amount ?? null,
            note: note ?? null
          })
        )
    })
  };
}

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { InvoiceBuddyAgent } from "../../src/agent";
import {
  SUBMISSION,
  SUPPORT_URL,
  TEST_DATA_MARK
} from "../../src/domain/credit-draft";
import { ALLOWED_URLS } from "../../src/services/grounding-service";
import { buildTools } from "../../src/tools";

const REASON = "A misconfigured Worker looped for two days.";

/** Runs steps inside one agent that is in a test scenario. */
async function inAgent<T>(
  name: string,
  scenario: string,
  steps: (agent: InvoiceBuddyAgent) => Promise<T>
): Promise<T> {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    if (agent.state.dataMode.dataset !== "test") {
      await agent.setDataMode("test", scenario);
    }
    return await steps(agent);
  });
}

const audit = (agent: InvoiceBuddyAgent) =>
  agent.sql<{ actor: string; action: string; subject_id: string | null }>`
    SELECT actor, action, subject_id FROM audit_log
    WHERE action LIKE 'credit_%' ORDER BY id`;

describe("draftCreditRequest (UC-3)", () => {
  it("writes a draft from the account's data, with the overage as the amount, and stores it", async () => {
    await inAgent("credit-draft", "usage-spike", async (agent) => {
      const facts = await agent.explainBill({});
      const workers = facts.services.find((s) => s.service === "Workers");
      const result = await agent.draftCreditRequest({
        service: "workers",
        ownerReason: REASON
      });
      if (result.status !== "drafted") throw new Error(result.status);
      expect(result.request).toMatchObject({
        service: "Workers",
        amount: workers?.difference,
        basis: "account_data",
        state: "drafted",
        dataset: "test",
        testData: true,
        month: facts.period.start.slice(0, 7)
      });
      expect(result.request.draft).toContain(
        `Amount requested: ${workers?.difference}`
      );
      expect(result.request.draft).toContain(`"${REASON}"`);
      expect(result.request.draft.startsWith(TEST_DATA_MARK)).toBe(true);
      expect(result.submission).toBe(SUBMISSION);
      expect(agent.getCreditRequests().map((r) => r.id)).toEqual([
        result.request.id
      ]);
      expect(audit(agent)).toEqual([
        {
          actor: "agent",
          action: "credit_draft",
          subject_id: result.request.id
        }
      ]);
    });
  });

  it("states only figures that are in the account's data", async () => {
    await inAgent("credit-figures", "usage-spike", async (agent) => {
      const facts = JSON.stringify(await agent.explainBill({}));
      const result = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: "It looped."
      });
      if (result.status !== "drafted") throw new Error(result.status);
      const amounts = result.request.draft.match(/\$[\d,]+\.\d{2}/g) ?? [];
      expect(amounts.length).toBeGreaterThan(2);
      for (const amount of amounts) expect(facts).toContain(amount);
    });
  });

  it("shows the existing draft instead of writing a second one", async () => {
    await inAgent("credit-existing", "usage-spike", async (agent) => {
      const first = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      const second = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: "A different reason."
      });
      if (first.status !== "drafted" || second.status !== "existing") {
        throw new Error(`${first.status}, ${second.status}`);
      }
      expect(second.request.id).toBe(first.request.id);
      expect(second.request.draft).toContain(REASON);
      expect(agent.getCreditRequests()).toHaveLength(1);
      expect(audit(agent)).toHaveLength(1);
    });
  });

  it("replaces a draft only when asked, and keeps the old one as replaced", async () => {
    await inAgent("credit-replace", "usage-spike", async (agent) => {
      const first = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      const second = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: "Second reason.",
        replaceExisting: true
      });
      if (first.status !== "drafted" || second.status !== "replaced") {
        throw new Error(`${first.status}, ${second.status}`);
      }
      const states = Object.fromEntries(
        agent.getCreditRequests().map((r) => [r.id, r.state])
      );
      expect(states).toEqual({
        [first.request.id]: "superseded",
        [second.request.id]: "drafted"
      });
    });
  });

  it("says the claim rests on the owner's statement when the data shows no anomaly", async () => {
    await inAgent("credit-no-anomaly", "usage-spike", async (agent) => {
      const result = await agent.draftCreditRequest({
        service: "R2",
        ownerReason: "I think R2 was overcharged."
      });
      if (result.status !== "drafted") throw new Error(result.status);
      expect(result.request.basis).toBe("owner_statement");
      expect(result.request.amount).toBeNull();
      expect(result.request.draft).toContain(
        "This request rests on the account owner's statement above."
      );
    });
  });

  it("names the products with charges when asked about one that has none", async () => {
    await inAgent("credit-unknown", "usage-spike", async (agent) => {
      const result = await agent.draftCreditRequest({
        service: "Stream",
        ownerReason: REASON
      });
      expect(result).toMatchObject({ status: "unknown_service" });
      expect(result.status === "unknown_service" && result.services).toEqual(
        expect.arrayContaining(["Workers", "R2"])
      );
      expect(agent.getCreditRequests()).toEqual([]);
    });
  });

  it("drafts nothing for a period with no charges", async () => {
    await inAgent("credit-zero", "zero-bill", async (agent) => {
      const result = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      expect(result).toMatchObject({ status: "unknown_service", services: [] });
    });
  });
});

describe("credit request history and outcomes (UC-4)", () => {
  it("keeps drafts across conversations and apart from the other data mode", async () => {
    const id = await inAgent("credit-history", "usage-spike", async (agent) => {
      const result = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      if (result.status !== "drafted") throw new Error(result.status);
      return result.request.id;
    });
    await inAgent("credit-history", "usage-spike", async (agent) => {
      // A later conversation: the chat history is gone, the drafts are not.
      await agent.persistMessages([]);
      expect(agent.getCreditRequests().map((r) => r.id)).toEqual([id]);
      await agent.setDataMode("live");
      expect(agent.getCreditRequests()).toEqual([]);
    });
  });

  it("records what the owner reports, as the owner's report", async () => {
    await inAgent("credit-outcome", "usage-spike", async (agent) => {
      const drafted = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      if (drafted.status !== "drafted") throw new Error(drafted.status);
      const id = drafted.request.id;
      const result = agent.recordCreditOutcome({
        id,
        outcome: "partially_approved",
        amount: " $120.00 ",
        note: "Told by email\non Friday."
      });
      if (result.status !== "recorded") throw new Error(result.status);
      expect(result.request).toMatchObject({
        state: "reported_partially_approved",
        stateInWords: "Partially approved, as reported by the account owner.",
        reportedAmount: "$120.00",
        reportedNote: "Told by email on Friday.",
        amount: drafted.request.amount
      });
      expect(audit(agent).at(-1)).toEqual({
        actor: "owner",
        action: "credit_outcome",
        subject_id: id
      });
    });
  });

  it("records nothing for an unknown draft, a replaced draft or an outcome it does not know", async () => {
    await inAgent("credit-outcome-bad", "usage-spike", async (agent) => {
      const first = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON,
        replaceExisting: true
      });
      if (first.status !== "drafted") throw new Error(first.status);
      expect(
        agent.recordCreditOutcome({ id: "cr_nope", outcome: "approved" })
      ).toEqual({ status: "not_found" });
      expect(
        agent.recordCreditOutcome({ id: first.request.id, outcome: "approved" })
      ).toEqual({ status: "replaced" });
      expect(
        agent.recordCreditOutcome({ id: first.request.id, outcome: "paid" })
      ).toEqual({ status: "invalid_outcome" });
      expect(
        audit(agent).filter((row) => row.action === "credit_outcome")
      ).toEqual([]);
    });
  });
});

describe("credit request tools", () => {
  type Execute = (
    input: unknown,
    options: { toolCallId: string; messages: [] }
  ) => Promise<Record<string, unknown>>;
  const run =
    (agent: InvoiceBuddyAgent, tool: keyof ReturnType<typeof buildTools>) =>
    (input: unknown) =>
      (buildTools(agent)[tool].execute as unknown as Execute)(input, {
        toolCallId: "t1",
        messages: []
      });

  it("gives the model the draft, the fixed submission steps and the rule that it never submits", async () => {
    await inAgent("credit-tool", "usage-spike", async (agent) => {
      const output = await run(
        agent,
        "draftCreditRequest"
      )({
        service: "Workers",
        ownerReason: REASON,
        month: "last month",
        replaceExisting: null
      });
      expect(output.status).toBe("drafted");
      expect(output.notice).toContain(TEST_DATA_MARK);
      expect(output.instruction).toContain(
        "never say it was or will be submitted"
      );
      expect(output.submission).toEqual(SUBMISSION);
      expect(output.request).toMatchObject({
        service: "Workers",
        basis: "supported by the account's usage data",
        state: "Drafted. Not known to be submitted."
      });
      const again = await run(
        agent,
        "draftCreditRequest"
      )({
        service: "Workers",
        ownerReason: REASON
      });
      expect(again.status).toBe("existing");
      expect(again.instruction).toContain("ask whether to replace it");
    });
  });

  it("tells the model what to say when the product has no charges", async () => {
    await inAgent("credit-tool-unknown", "usage-spike", async (agent) => {
      const output = await run(
        agent,
        "draftCreditRequest"
      )({
        service: "Stream",
        ownerReason: REASON
      });
      expect(output.status).toBe("unknown_service");
      expect(output.productsWithCharges).toEqual(
        expect.arrayContaining(["Workers"])
      );
    });
  });

  it("lists drafts with the owner's reports marked as such", async () => {
    await inAgent("credit-tool-list", "usage-spike", async (agent) => {
      const empty = await run(agent, "getCreditRequests")({});
      expect(empty.requests).toEqual([]);
      expect(empty.instruction).toContain("No credit request has been drafted");
      const drafted = await agent.draftCreditRequest({
        service: "Workers",
        ownerReason: REASON
      });
      if (drafted.status !== "drafted") throw new Error(drafted.status);
      const recorded = await run(
        agent,
        "recordCreditOutcome"
      )({
        id: drafted.request.id,
        outcome: "Partially Approved",
        amount: "$50.00"
      });
      expect(recorded.status).toBe("recorded");
      const listed = await run(agent, "getCreditRequests")({});
      expect(listed.instruction).toContain("as you reported");
      expect(listed.requests).toMatchObject([
        {
          id: drafted.request.id,
          state: "Partially approved, as reported by the account owner.",
          amountReportedByOwner: "$50.00"
        }
      ]);
    });
  });

  it("waits for the owner before recording an outcome, and explains a failed one", async () => {
    await inAgent("credit-tool-outcome", "usage-spike", async (agent) => {
      const tools = buildTools(agent);
      expect(tools.recordCreditOutcome.needsApproval).toBe(true);
      expect(tools.draftCreditRequest.needsApproval).toBeUndefined();
      const output = await run(
        agent,
        "recordCreditOutcome"
      )({
        id: "cr_nope",
        outcome: "approved"
      });
      expect(output).toMatchObject({ status: "not_found" });
      expect(output.instruction).toContain("Nothing was recorded");
    });
  });
});

describe("the support link (G-7)", () => {
  it("is on the list of links the assistant may give", () => {
    expect(ALLOWED_URLS).toContain(SUPPORT_URL);
  });
});

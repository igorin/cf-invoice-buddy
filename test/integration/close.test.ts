import { env } from "cloudflare:workers";
import { introspectWorkflow, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { InvoiceBuddyAgent } from "../../src/agent";
import type { CloseView } from "../../src/services/close-service";
import { buildTools } from "../../src/tools";

/** Runs steps inside one agent that is in a test scenario. */
async function inAgent<T>(
  name: string,
  steps: (agent: InvoiceBuddyAgent) => Promise<T>,
  scenario = "usage-spike"
): Promise<T> {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    if (agent.state.dataMode.dataset !== "test") {
      await agent.setDataMode("test", scenario);
    }
    return await steps(agent);
  });
}

const closeOf = (agent: InvoiceBuddyAgent, workflowId: string): CloseView => {
  const close = agent
    .getInvoiceCloses()
    .find((item) => item.workflowId === workflowId);
  if (!close) throw new Error(`no close ${workflowId}`);
  return close;
};

const audit = (agent: InvoiceBuddyAgent) =>
  agent.sql<{ actor: string; action: string }>`
    SELECT actor, action FROM audit_log WHERE action LIKE 'close_%' ORDER BY id`;

/** Starts a close of the last finished month and returns its workflow id. */
async function start(name: string): Promise<string> {
  return await inAgent(name, async (agent) => {
    const result = await agent.startInvoiceClose();
    if (result.status !== "started") throw new Error(result.status);
    return result.close.workflowId;
  });
}

describe("invoice close workflow (UC-6)", () => {
  it("snapshots, totals and checks the period, then waits for the owner", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    const workflowId = await start("close-wait");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-wait", async (agent) => {
      const close = closeOf(agent, workflowId);
      expect(close.state).toBe("awaiting_approval");
      expect(close.stateInWords).toContain("still open");
      expect(close.testData).toBe(true);
      expect(close.summary?.total).toMatch(/^\$[\d,]+\.\d{2}$/);
      expect(close.summary?.lineItems?.map((line) => line.service)).toEqual(
        expect.arrayContaining(["Workers", "R2"])
      );
      // The scenario has an invoice for the period that equals its usage.
      expect(close.summary?.reconciliation?.status).toBe("matched");
      expect(close.summary?.findings).toBeDefined();
      expect(agent.state.pendingApprovals.map((c) => c.workflowId)).toEqual([
        workflowId
      ]);
      expect(audit(agent)).toEqual([
        { actor: "agent", action: "close_started" }
      ]);
    });
  });

  it("closes the period when the owner approves, once only", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    const workflowId = await start("close-approve");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-approve", async (agent) => {
      const decision = await agent.decideClose(
        workflowId,
        true,
        " Looks right. "
      );
      expect(decision.status).toBe("approved");
      // Approval is recorded at once; the workflow then finalizes.
      expect(agent.state.pendingApprovals).toEqual([]);
    });
    await instance?.waitForStatus("complete");

    await inAgent("close-approve", async (agent) => {
      const close = closeOf(agent, workflowId);
      expect(close.state).toBe("closed");
      expect(close.closedAt).not.toBeNull();
      expect(close.decidedReason).toBe("Looks right.");
      expect(audit(agent)).toEqual([
        { actor: "agent", action: "close_started" },
        { actor: "owner", action: "close_approved" }
      ]);
      // A closed period cannot be closed again or decided again.
      const again = await agent.startInvoiceClose();
      expect(again.status).toBe("already_closed");
      expect(await agent.decideClose(workflowId, false)).toEqual({
        status: "not_pending"
      });
      expect(await agent.closeStep(workflowId, "reject")).toBe("closed");
      expect(await agent.closeStep(workflowId, "fail")).toBe("closed");
      expect(closeOf(agent, workflowId)).toEqual(close);
    });
  });

  it("leaves the period open when the owner rejects, and lets the close start again", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    const workflowId = await start("close-reject");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-reject", async (agent) => {
      const decision = await agent.decideClose(
        workflowId,
        false,
        "Wrong month"
      );
      expect(decision.status).toBe("rejected");
      const close = closeOf(agent, workflowId);
      expect(close.state).toBe("rejected");
      expect(close.closedAt).toBeNull();
      expect(close.decidedReason).toBe("Wrong month");
      expect(agent.state.pendingApprovals).toEqual([]);
      expect(audit(agent).at(-1)).toEqual({
        actor: "owner",
        action: "close_rejected"
      });
    });
    await instance?.waitForStepResult({ name: "leave-open" });

    await inAgent("close-reject", async (agent) => {
      // The workflow's own ending does not turn a rejection into a failure.
      expect(closeOf(agent, workflowId).state).toBe("rejected");
      const again = await agent.startInvoiceClose();
      if (again.status !== "started") throw new Error(again.status);
      expect(again.close.workflowId).not.toBe(workflowId);
      expect(agent.getInvoiceCloses()).toHaveLength(1);
    });
  });

  it("expires, with the period still open, when nobody decides in time", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    await workflows.modifyAll(async (modifier) => {
      await modifier.forceEventTimeout({ name: "wait-for-approval" });
    });
    const workflowId = await start("close-expire");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "leave-open" });

    await inAgent("close-expire", async (agent) => {
      const close = closeOf(agent, workflowId);
      expect(close.state).toBe("expired");
      expect(close.closedAt).toBeNull();
      expect(agent.state.pendingApprovals).toEqual([]);
      expect((await agent.startInvoiceClose()).status).toBe("started");
    });
  });

  it("keeps the snapshot when the period's data changes afterwards or a step runs twice", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    const workflowId = await start("close-frozen");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-frozen", async (agent) => {
      const before = closeOf(agent, workflowId);
      // Another scenario replaces the test dataset's usage.
      await agent.setDataMode("test", "lower-no-cause");
      for (const step of ["snapshot", "anomaly-check"] as const) {
        await agent.closeStep(workflowId, step);
      }
      const after = closeOf(agent, workflowId);
      expect(after.summary?.total).toBe(before.summary?.total);
      expect(after.summary?.lineItems).toEqual(before.summary?.lineItems);
      expect(after.state).toBe("awaiting_approval");
    });
  });

  it("does not finalize a close the owner has not approved", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    const workflowId = await start("close-guard");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-guard", async (agent) => {
      expect(await agent.closeStep(workflowId, "finalize")).toBe(
        "awaiting_approval"
      );
      expect(
        await agent.closeStep("close-test-unknown", "finalize")
      ).toBeNull();
      expect(await agent.decideClose(workflowId, "yes")).toEqual({
        status: "not_pending"
      });
      expect(await agent.decideClose("close-test-unknown", true)).toEqual({
        status: "not_pending"
      });
      expect(closeOf(agent, workflowId).state).toBe("awaiting_approval");
    });
  });

  it("allows one close at a time, refuses an unfinished period, and keeps test closes out of live data", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    const workflowId = await start("close-rules");
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-rules", async (agent) => {
      const second = await agent.startInvoiceClose();
      expect(second.status).toBe("in_progress");
      expect(second.status !== "started" && second.close?.workflowId).toBe(
        workflowId
      );
      const thisMonth = new Date().toISOString().slice(0, 7);
      const open = await agent.startInvoiceClose(thisMonth);
      expect(open).toMatchObject({ status: "open_period", month: thisMonth });

      await agent.setDataMode("live");
      expect(agent.getInvoiceCloses()).toEqual([]);
      expect(agent.state.pendingApprovals).toEqual([]);
      // A decision made in live mode cannot reach a test-mode close.
      expect(await agent.decideClose(workflowId, true)).toEqual({
        status: "not_pending"
      });
      await agent.setDataMode("test", "usage-spike");
      expect(agent.state.pendingApprovals.map((c) => c.workflowId)).toEqual([
        workflowId
      ]);
    });
  });
});

describe("invoice close tools (UC-6, NFR-S3)", () => {
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

  it("gives the model no way to approve, reject or finalize a close", async () => {
    await inAgent("close-tools-none", async (agent) => {
      const names = Object.keys(buildTools(agent));
      expect(names).toEqual(
        expect.arrayContaining(["startInvoiceClose", "getInvoiceCloses"])
      );
      expect(
        names.filter((name) => /approv|decid|reject|finali/i.test(name))
      ).toEqual([]);
    });
  });

  it("starts a close and tells the model that only the owner decides", async () => {
    await using workflows = await introspectWorkflow(
      env.INVOICE_CLOSE_WORKFLOW
    );
    await inAgent("close-tools-start", async (agent) => {
      const empty = await run(agent, "getInvoiceCloses")({});
      expect(empty.closes).toEqual([]);
      expect(empty.instruction).toContain("No invoice close has been started");

      const started = await run(agent, "startInvoiceClose")({ month: null });
      expect(started.status).toBe("started");
      expect(started.notice).toContain("TEST DATA");
      expect(started.instruction).toContain(
        "Only the owner can approve or reject"
      );
    });
    const [instance] = await workflows.get();
    await instance?.waitForStepResult({ name: "anomaly-check" });

    await inAgent("close-tools-start", async (agent) => {
      const listed = await run(agent, "getInvoiceCloses")({});
      expect(listed.closes).toMatchObject([
        {
          state:
            "Waiting for the owner to approve or reject. The period is still open.",
          closedOn: null
        }
      ]);
      const again = await run(agent, "startInvoiceClose")({});
      expect(again.status).toBe("in_progress");
      const open = await run(
        agent,
        "startInvoiceClose"
      )({
        month: new Date().toISOString().slice(0, 7)
      });
      expect(open.status).toBe("open_period");
      expect(open.instruction).toContain("has not ended");
    });
  });
});

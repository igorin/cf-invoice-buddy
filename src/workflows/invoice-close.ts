import {
  AgentWorkflow,
  type AgentWorkflowEvent,
  type AgentWorkflowStep
} from "agents/workflows";
import type { InvoiceBuddyAgent } from "../agent";

/**
 * The monthly invoice close (spec UC-6, section 8): snapshot, rate, anomaly
 * check, wait for the owner, finalize. The workflow only orders the steps
 * and waits; each step is done by the agent, on its own database, and is
 * safe to run again after a restart (NFR-O1).
 */

export type CloseParams = Readonly<{ workflowId: string }>;

/** How long a close waits for the owner before it expires. */
export const APPROVAL_TIMEOUT = "7 days";

/** The SDK's error for a rejected approval, matched by name across bundles. */
const isRejection = (error: unknown): boolean =>
  error instanceof Error && error.name === "WorkflowRejectedError";

export class InvoiceCloseWorkflow extends AgentWorkflow<
  InvoiceBuddyAgent,
  CloseParams
> {
  override async run(
    event: AgentWorkflowEvent<CloseParams>,
    step: AgentWorkflowStep
  ) {
    const { workflowId } = event.payload;
    const agent = this.agent;
    await step.do("snapshot", async () => {
      await agent.closeStep(workflowId, "snapshot");
    });
    await step.do("rate", async () => {
      await agent.closeStep(workflowId, "rate");
    });
    await step.do("anomaly-check", async () => {
      await agent.closeStep(workflowId, "anomaly-check");
    });

    try {
      await this.waitForApproval(step, { timeout: APPROVAL_TIMEOUT });
    } catch (error) {
      // Rejected by the owner, or nobody decided in time. Either way the
      // period stays open.
      const ending = isRejection(error) ? "reject" : "expire";
      await step.do("leave-open", async () => {
        await agent.closeStep(workflowId, ending);
      });
      return { workflowId, outcome: ending };
    }

    await step.do("finalize", async () => {
      await agent.closeStep(workflowId, "finalize");
    });
    await step.reportComplete({ workflowId, outcome: "closed" });
    return { workflowId, outcome: "closed" };
  }
}

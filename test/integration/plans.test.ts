import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import { InvoiceBuddyAgent } from "../../src/agent";
import { PRICE_TABLE } from "../../src/domain/plans";
import { buildTools } from "../../src/tools";

async function inAgent<T>(
  name: string,
  scenario: string,
  steps: (agent: InvoiceBuddyAgent) => Promise<T>
): Promise<T> {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    await agent.setDataMode("test", scenario);
    return await steps(agent);
  });
}

const thisMonth = () => new Date().toISOString().slice(0, 7);
const lastMonth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 7);
};

describe("comparePlans through the agent (UC-7)", () => {
  it("estimates the current month's usage on both plans, from the stored usage", async () => {
    await inAgent("plans-current", "usage-spike", async (agent) => {
      const result = await agent.comparePlans();
      expect(result).toMatchObject({
        month: thisMonth(),
        dataset: "test",
        scenario: "usage-spike",
        estimate: true,
        // The scenario's fixture account is on the paid plan.
        currentPlan: "paid"
      });
      expect(result.plans.map((plan) => plan.name)).toEqual([
        "Workers Free",
        "Workers Paid"
      ]);
      const [free, paid] = result.plans;
      expect(free?.total).toBe("$0.00");
      expect(free?.overLimit.map((item) => item.service)).toContain("Workers");
      expect(result.fitsFree).toBe(false);
      expect(paid?.base).toBe("$5.00");
      expect(paid?.lines.map((line) => line.service)).toEqual(["Workers"]);
      expect(Number(paid?.total.replace(/[$,]/g, ""))).toBeGreaterThan(5);
      // The scenario also has R2 storage, which the price table does not cover.
      expect(result.notPriced).toEqual([{ service: "R2", metric: "storage" }]);
      expect(result.verdict).toContain(String(paid?.total));
      expect(result.priceSource.checkedOn).toBe(PRICE_TABLE.checkedOn);
    });
  });

  it("compares a finished month when the owner names one", async () => {
    await inAgent("plans-named", "usage-spike", async (agent) => {
      const result = await agent.comparePlans(` ${lastMonth()} `);
      expect(result.month).toBe(lastMonth());
      expect(result.partial).toBe(false);
      expect(result.plans[1]?.lines.length).toBeGreaterThan(0);
    });
  });

  it("falls back to the current month for a value that is not a month or has not started", async () => {
    await inAgent("plans-loose", "usage-spike", async (agent) => {
      for (const month of ["next year", "2999-01", 7, null]) {
        expect((await agent.comparePlans(month)).month).toBe(thisMonth());
      }
    });
  });

  it("gives the model the estimate label, the verdict and the test-data notice", async () => {
    await inAgent("plans-tool", "usage-spike", async (agent) => {
      const execute = buildTools(agent).comparePlans.execute as unknown as (
        input: unknown,
        options: { toolCallId: string; messages: [] }
      ) => Promise<Record<string, unknown>>;
      const output = await execute(
        { month: "the usual" },
        { toolCallId: "t1", messages: [] }
      );
      expect(output.notice).toContain("TEST DATA");
      expect(output.instruction).toContain('use the word "estimate"');
      expect(output.instruction).toContain("Do not recommend a plan");
      expect(output.month).toBe(thisMonth());
      expect(String(output.verdict)).toContain("Workers Paid");
      expect(output).not.toHaveProperty("estimate");
    });
  });
});

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { afterEach, describe, expect, it } from "vitest";
import { InvoiceBuddyAgent } from "../../src/agent";
import { fromUsd } from "../../src/domain/money";
import {
  addDays,
  isoDate,
  periodContaining,
  previousPeriod,
  type IsoDate
} from "../../src/domain/periods";
import type { UsageRecord } from "../../src/domain/usage";
import type { BillingInfo } from "../../src/ports/sources";
import { readExplainInput } from "../../src/tools";
import { describeForModel } from "../../src/tools/explain-tool";

const today = () => isoDate(new Date().toISOString().slice(0, 10));
const thisMonth = () => periodContaining(today(), 1);
const lastMonth = () => previousPeriod(thisMonth(), 1);
const monthOf = (date: IsoDate) => date.slice(0, 7);

const workers = (date: IsoDate, usd: number): UsageRecord => ({
  date,
  service: "Workers",
  metric: "requests",
  zone: null,
  quantity: usd * 1_000_000,
  unit: "requests",
  billableQuantity: null,
  costMicros: fromUsd(usd)
});

const COSTED: BillingInfo = {
  plan: "paid",
  billing: { status: "costed" },
  invoices: []
};

const originals = {
  usage: InvoiceBuddyAgent.usageSourceFactory,
  billing: InvoiceBuddyAgent.billingSourceFactory
};

afterEach(() => {
  InvoiceBuddyAgent.usageSourceFactory = originals.usage;
  InvoiceBuddyAgent.billingSourceFactory = originals.billing;
});

/** A fake account: $10 a day this month, $4 a day in any earlier month. */
function useAccount(
  options: { failOnce?: boolean; billing?: BillingInfo } = {}
) {
  const calls: Array<{ from: IsoDate; to: IsoDate }> = [];
  let failures = options.failOnce ? 1 : 0;
  InvoiceBuddyAgent.usageSourceFactory = () => ({
    fetchUsage: async (from, to) => {
      calls.push({ from, to });
      const isEarlier = to < thisMonth().start;
      if (isEarlier && failures-- > 0) {
        return {
          records: [],
          sources: [
            { service: "Workers", available: false, reason: "HTTP 503" }
          ]
        };
      }
      const records: UsageRecord[] = [];
      for (let date = from; date <= to; date = addDays(date, 1)) {
        records.push(workers(date, isEarlier ? 4 : 10));
      }
      return { records, sources: [{ service: "Workers", available: true }] };
    }
  });
  InvoiceBuddyAgent.billingSourceFactory = () => ({
    fetchBilling: async () => options.billing ?? COSTED
  });
  return calls;
}

async function withAgent<T>(
  name: string,
  body: (agent: InvoiceBuddyAgent) => Promise<T>
): Promise<T> {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, body);
}

describe("explainBill on live data (UC-1)", () => {
  it("has no baseline until the owner names a month, and fetches none on its own", async () => {
    const calls = useAccount();
    const view = await withAgent("explain-live-none", (a) => a.explainBill());
    expect(view.outcome).toBe("no_baseline");
    expect(view.dataset).toBe("live");
    expect(view.baseline).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.from).toBe(thisMonth().start);
  });

  it("fetches the month the owner names and compares against it", async () => {
    const calls = useAccount();
    const baselineMonth = monthOf(lastMonth().start);
    const view = await withAgent("explain-live-named", (a) =>
      a.explainBill({ baselineMonth })
    );
    expect(view.baseline?.months).toEqual([baselineMonth]);
    expect(view.baseline?.direction).toBe("higher");
    expect(view.services[0]).toMatchObject({
      service: "Workers",
      direction: "higher"
    });
    expect(calls.map((c) => c.from)).toEqual([
      thisMonth().start,
      lastMonth().start
    ]);
    expect(calls[1]?.to).toBe(addDays(lastMonth().end, -1));
  });

  it("keeps a fetched month and does not fetch it again", async () => {
    const calls = useAccount();
    const baselineMonth = monthOf(lastMonth().start);
    await withAgent("explain-live-kept", async (agent) => {
      await agent.explainBill({ baselineMonth });
      await agent.explainBill({ baselineMonth });
    });
    expect(calls.filter((c) => c.from === lastMonth().start)).toHaveLength(1);
  });

  it("uses a month fetched earlier as the baseline later, without being asked", async () => {
    useAccount();
    const view = await withAgent("explain-live-reuse", async (agent) => {
      await agent.explainBill({ baselineMonth: monthOf(lastMonth().start) });
      return agent.explainBill();
    });
    // One stored month is not enough for a baseline nobody chose.
    expect(view.outcome).toBe("no_baseline");
  });

  it("fetches a month again if a product failed the first time", async () => {
    const calls = useAccount({ failOnce: true });
    const baselineMonth = monthOf(lastMonth().start);
    const views = await withAgent("explain-live-retry", async (agent) => [
      await agent.explainBill({ baselineMonth }),
      await agent.explainBill({ baselineMonth })
    ]);
    expect(calls.filter((c) => c.from === lastMonth().start)).toHaveLength(2);
    expect(views[1]?.baseline?.direction).toBe("higher");
  });

  it("includes the assistant's own usage, which is real, on live data only", async () => {
    useAccount();
    const view = await withAgent("explain-live-own", (a) => a.explainBill());
    expect(view.assistantOwnUsage).toContain(
      "at list price before the free daily allocation"
    );
  });

  it("says there are no charges on an account that has none", async () => {
    useAccount({
      billing: { plan: "free", billing: { status: "none" }, invoices: [] }
    });
    InvoiceBuddyAgent.usageSourceFactory = () => ({
      fetchUsage: async () => ({ records: [], sources: [] })
    });
    const view = await withAgent("explain-live-free", (a) => a.explainBill());
    expect(view.outcome).toBe("no_charges");
  });

  it.each([
    ["a malformed month", { month: "October" }],
    ["a month that has not started", { month: "2999-01" }],
    ["a malformed baseline month", { baselineMonth: "2026-13" }]
  ])("rejects %s", async (_name, request) => {
    useAccount();
    await withAgent(`explain-bad-${JSON.stringify(request)}`, async (agent) => {
      await expect(agent.explainBill(request)).rejects.toThrow();
    });
  });
});

describe("explainBill in test mode (UC-10)", () => {
  it("explains a spike from the scenario, with no live figure mixed in (G-9)", async () => {
    const view = await withAgent("explain-test-spike", async (agent) => {
      await agent.setDataMode("test", "usage-spike");
      return agent.explainBill();
    });
    expect(view.dataset).toBe("test");
    expect(view.scenario).toBe("usage-spike");
    expect(view.outcome).toBe("explained");
    expect(view.findings[0]?.statement).toContain("Workers cost");
    expect(view.baseline?.months).toHaveLength(3);
    expect(view.assistantOwnUsage).toBeNull();
  });

  it("finds nothing in the lower-bill scenario (G-4)", async () => {
    const view = await withAgent("explain-test-lower", async (agent) => {
      await agent.setDataMode("test", "lower-no-cause");
      return agent.explainBill();
    });
    expect(view.outcome).toBe("none_found");
    expect(view.findings).toEqual([]);
  });

  it("explains an earlier month, whose invoice matches its usage", async () => {
    const view = await withAgent("explain-test-earlier", async (agent) => {
      await agent.setDataMode("test", "usage-spike");
      return agent.explainBill({ month: monthOf(lastMonth().start) });
    });
    expect(view.partial).toBe(false);
    expect(view.period.start).toBe(lastMonth().start);
    // The invoice equals the usage, so no variance. The only thing that can
    // differ is the number of days in the month.
    expect(
      view.findings.every((f) => f.statement.startsWith("This period has"))
    ).toBe(true);
  });
});

describe("bill explanation as given to the model", () => {
  it("tells the model exactly what to say when nothing was found", async () => {
    const view = await withAgent("model-none", async (agent) => {
      await agent.setDataMode("test", "lower-no-cause");
      return agent.explainBill();
    });
    const described = describeForModel(view);
    expect(described.notice).toContain("TEST DATA");
    expect(described.instruction).toContain(
      "I can't explain this difference from the account's data."
    );
    expect(described.instruction).toContain(
      "Never suggest a reason of your own."
    );
  });

  it("tells the model to ask for a month when there is no baseline", async () => {
    useAccount();
    const view = await withAgent("model-nobase", (a) => a.explainBill());
    const described = describeForModel(view);
    expect(described.notice).toBe("Live account data.");
    expect(described.instruction).toContain(
      "ask the owner which month to compare against"
    );
  });
});

describe("getAssistantCost (UC-8)", () => {
  it("reports the meter with every figure as text and states its limits", async () => {
    const report = await withAgent("cost-report", async (agent) => {
      agent.sql`
        INSERT INTO self_usage (at, model, steps, input_tokens, output_tokens, neurons, cost_micros, metered)
        VALUES (${new Date().toISOString()}, 'm', 2, 343, 31, 15.5, 170, 1)`;
      agent.sql`
        INSERT INTO self_usage (at, model, steps, metered)
        VALUES (${new Date().toISOString()}, 'm', 1, 0)`;
      return agent.getAssistantCost();
    });
    expect(report.monthToDate).toEqual({
      meteredModelCost: "$0.00",
      neurons: "15.5",
      inputTokens: "343",
      outputTokens: "31",
      chatTurns: "2",
      unmeteredTurns: "1",
      turnsRefusedOverBudget: "0"
    });
    expect(report.today).toEqual({
      neurons: "15.5",
      dailyBudget: `${Number(env.DAILY_NEURON_BUDGET).toLocaleString("en-US")} neurons`
    });
    expect(report.lastDays).toHaveLength(1);
    expect(report.limits).toHaveLength(3);
    expect(report.notice).toContain("never test data");
    expect(report.priceSource).toContain("developers.cloudflare.com");
  });
});

describe("explainBillChange tool input", () => {
  it("passes valid months through", () => {
    expect(
      readExplainInput({ month: "2026-09", baselineMonth: " 2026-08 " })
    ).toEqual({
      request: { month: "2026-09", baselineMonth: "2026-08" },
      ignored: []
    });
  });

  it("treats missing, null and blank values as not given", () => {
    expect(readExplainInput({ month: null, baselineMonth: "  " })).toEqual({
      request: {},
      ignored: []
    });
    expect(readExplainInput({})).toEqual({ request: {}, ignored: [] });
  });

  // Seen live: asked "Why is my bill $412 when it's usually $150?", the model
  // filled the fields with words from the question and, with a strict
  // schema, retried until the turn ended with no reply.
  it("drops a value that is not a month and says so, instead of failing", () => {
    expect(readExplainInput({ month: "$412", baselineMonth: "usual" })).toEqual(
      {
        request: {},
        ignored: [
          '"$412" is not a month, so the current month is shown.',
          '"usual" is not a month, so it was not used as the baseline.'
        ]
      }
    );
  });
});

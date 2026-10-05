import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTED_MESSAGE,
  InvoiceBuddyAgent,
  createModel
} from "../../src/agent";

function mockModel(inputTokens: number, outputTokens: number) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "ok" },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: {
                total: inputTokens,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined
              },
              outputTokens: {
                total: outputTokens,
                text: undefined,
                reasoning: undefined
              }
            }
          }
        ]
      })
    })
  });
}

async function sendTurn(name: string) {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    await agent.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello" }]
      }
    ]);
    const rows = agent.sql<{
      metered: number;
      input_tokens: number | null;
      neurons: number | null;
      cost_micros: number | null;
    }>`SELECT metered, input_tokens, neurons, cost_micros FROM self_usage ORDER BY id`;
    const lastText = agent.messages
      .at(-1)
      ?.parts.map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    return { rows, state: agent.state, lastText };
  });
}

afterEach(() => {
  InvoiceBuddyAgent.modelFactory = createModel;
});

describe("cost meter in the agent (UC-8)", () => {
  it("records one metered row per turn and publishes it in state", async () => {
    InvoiceBuddyAgent.modelFactory = () => mockModel(343, 31);

    const { rows, state } = await sendTurn("meter-metered");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      metered: 1,
      input_tokens: 343,
      cost_micros: 170
    });
    expect(rows[0]?.neurons).toBeCloseTo(15.496, 3);
    expect(state.selfCost.monthCostMicros).toBe(170);
    expect(state.selfCost.todayNeurons).toBeCloseTo(15.496, 3);
    expect(state.selfCost.dailyBudgetNeurons).toBe(10_000);
    expect(state.selfCost.unmeteredTurns).toBe(0);
  });

  it("records a turn with zero input tokens as unmetered and estimates nothing", async () => {
    InvoiceBuddyAgent.modelFactory = () => mockModel(0, 0);

    const { rows, state } = await sendTurn("meter-unmetered");

    expect(rows).toEqual([
      { metered: 0, input_tokens: null, neurons: null, cost_micros: null }
    ]);
    expect(state.selfCost.unmeteredTurns).toBe(1);
    expect(state.selfCost.monthCostMicros).toBe(0);
  });
});

describe("daily budget (NFR-O3)", () => {
  it("refuses a turn at 100% of budget without calling the model", async () => {
    const model = mockModel(10, 1);
    InvoiceBuddyAgent.modelFactory = () => model;
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "budget-full");
    await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
      agent.sql`
        INSERT INTO self_usage (at, model, steps, input_tokens, output_tokens, neurons, cost_micros, metered)
        VALUES (${new Date().toISOString()}, 'm', 1, 1, 1, 10000, 110000, 1)`;
    });

    const { rows, lastText } = await sendTurn("budget-full");

    expect(model.doStreamCalls).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(lastText).toBe(BUDGET_EXHAUSTED_MESSAGE);
  });
});

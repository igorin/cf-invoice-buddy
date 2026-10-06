import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWANCE_EXHAUSTED_MESSAGE,
  TURN_FAILED_MESSAGE,
  describeTurnError
} from "../../src/services/turn-guard";
import {
  BUDGET_EXHAUSTED_MESSAGE,
  InvoiceBuddyAgent,
  NO_ANSWER_MESSAGE,
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
    expect(state.selfCost.dailyBudgetNeurons).toBe(
      Number(env.DAILY_NEURON_BUDGET)
    );
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

describe("loop guard (free-tier limit)", () => {
  // A model that calls a tool with unparseable input on every step, as the
  // real model did on 2026-10-05 before the stream fix.
  function loopingModel() {
    return new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: crypto.randomUUID(),
              toolName: "explainBillChange",
              input: '{"month": "{"month": "20220244'
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: {
                inputTokens: {
                  total: 100,
                  noCache: undefined,
                  cacheRead: undefined,
                  cacheWrite: undefined
                },
                outputTokens: {
                  total: 10,
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

  it("stops a turn after two failed tool calls in a row and says so", async () => {
    const model = loopingModel();
    InvoiceBuddyAgent.modelFactory = () => model;

    const { lastText, rows } = await sendTurn("loop-abort");

    expect(model.doStreamCalls).toHaveLength(2);
    expect(lastText).toBe(NO_ANSWER_MESSAGE);
    expect(rows).toHaveLength(1);
  });
});

describe("per-instance budgets (free-tier limit)", () => {
  it("gives the smoke-test instance its own, separate budget", async () => {
    InvoiceBuddyAgent.modelFactory = () => mockModel(10, 1);
    const owner = await sendTurn("budget-owner");
    const smoke = await sendTurn("budget-owner-smoke");
    expect(owner.state.selfCost.dailyBudgetNeurons).toBe(
      Number(env.DAILY_NEURON_BUDGET)
    );
    expect(smoke.state.selfCost.dailyBudgetNeurons).toBe(
      Number(env.SMOKE_DAILY_NEURON_BUDGET)
    );
  });
});

describe("a model call that Cloudflare refuses", () => {
  it.each([
    [
      "4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.",
      ALLOWANCE_EXHAUSTED_MESSAGE
    ],
    ["upstream timeout", TURN_FAILED_MESSAGE]
  ])("turns %j into a line the owner can act on", (error, expected) => {
    expect(describeTurnError(error)).toBe(expected);
  });
});

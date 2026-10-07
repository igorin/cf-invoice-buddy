import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { streamText, type LanguageModel } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkersAI } from "workers-ai-provider";
import { InvoiceBuddyAgent, createModel } from "../../src/agent";
import { withDedupedStream } from "../../src/domain/dedupe-stream";
import {
  replayBinding,
  type RecordedCall
} from "../../src/domain/model-recording";
import { CHAT_MODEL_ID, PLUMBING_MODEL_ID } from "../../src/domain/models";
import type { ScenarioId } from "../../src/domain/scenarios";
import { UNVERIFIED_MESSAGE } from "../../src/domain/verified-stream";

/**
 * Replay tests (spec section 10): a turn is run through the real agent, the
 * real stream handling and the real response checker, with the model's
 * recorded raw stream in place of a model call.
 */

type Cassette = Readonly<{
  id: string;
  recordedOn: string;
  scenario: ScenarioId;
  question: string;
  calls: ReadonlyArray<RecordedCall>;
  reply: string;
  tools: ReadonlyArray<string>;
}>;

const originals = {
  model: InvoiceBuddyAgent.modelFactory,
  clock: InvoiceBuddyAgent.clock
};

afterEach(() => {
  InvoiceBuddyAgent.modelFactory = originals.model;
  InvoiceBuddyAgent.clock = originals.clock;
});

/** The model as the app builds it, fed from a recording. */
function replayModel(calls: ReadonlyArray<RecordedCall>): LanguageModel {
  const binding = withDedupedStream(replayBinding(calls)) as unknown as Ai;
  return createWorkersAI({ binding })(CHAT_MODEL_ID);
}

async function replay(
  name: string,
  scenario: ScenarioId,
  question: string,
  calls: (total: string) => ReadonlyArray<RecordedCall>
) {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    await agent.setDataMode("test", scenario);
    const facts = await agent.explainBill({});
    InvoiceBuddyAgent.modelFactory = () => replayModel(calls(facts.total));
    await agent.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: question }]
      }
    ]);
    const last = agent.messages.at(-1);
    return {
      total: facts.total,
      role: last?.role,
      reply: (last?.parts ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(""),
      tools: (last?.parts ?? [])
        .filter((part) => part.type.startsWith("tool-"))
        .map((part) => part.type.replace("tool-", ""))
    };
  });
}

const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
const DONE = "data: [DONE]\n\n";

/** A text token as Llama 3.3 streams it: once in each of two fields (B8). */
const token = (text: string) =>
  event({ response: text, choices: [{ delta: { content: text } }] });

/** A tool call as Llama 3.3 streams it, also carried twice. */
const toolCall = (name: string): RecordedCall => ({
  chunks: [
    event({
      response: "",
      choices: [
        {
          delta: {
            tool_calls: [
              { function: { name }, id: "call-1", index: 0, type: "function" }
            ]
          }
        }
      ],
      tool_calls: [{ name }]
    }),
    event({
      choices: [
        { delta: { tool_calls: [{ function: { arguments: "{}" }, index: 0 }] } }
      ],
      tool_calls: [{ arguments: "{}" }]
    }),
    event({
      response: "",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912 }
    }),
    DONE
  ]
});

const answer = (...tokens: string[]): RecordedCall => {
  const stream =
    tokens.map(token).join("") +
    event({
      response: "",
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1400, completion_tokens: 20, total_tokens: 1420 }
    }) +
    DONE;
  // Cut mid-event, as the network does.
  const cut = Math.floor(stream.length / 2);
  return { chunks: [stream.slice(0, cut), stream.slice(cut)] };
};

describe("replaying a recorded turn through the agent", () => {
  it("runs the tool, removes the doubled text and shows the checked answer", async () => {
    const result = await replay(
      "replay-good",
      "usage-spike",
      "Why is my bill higher?",
      (total) => [
        toolCall("explainBillChange"),
        answer("Your", " bill", " is ", total, ". This is TEST DATA.")
      ]
    );
    expect(result.role).toBe("assistant");
    expect(result.tools).toEqual(["explainBillChange"]);
    expect(result.reply).toBe(
      `Your bill is ${result.total}. This is TEST DATA.`
    );
  });

  it("withholds a recorded answer whose figure no tool returned", async () => {
    const result = await replay(
      "replay-bad",
      "usage-spike",
      "Why is my bill higher?",
      () => [
        toolCall("explainBillChange"),
        answer("Your", " bill", " is ", "$9,999.99", ".")
      ]
    );
    expect(result.tools).toEqual(["explainBillChange"]);
    expect(result.reply).toBe(UNVERIFIED_MESSAGE);
  });
});

// Recordings of the real model, made by `npm run record` (spec section 10).
const cassettes = Object.values(
  import.meta.glob<Cassette>("../cassettes/*.json", {
    eager: true,
    import: "default"
  })
);

describe("recordings of the real model", () => {
  it.skipIf(cassettes.length > 0)("none have been recorded yet", () => {
    expect(cassettes).toEqual([]);
  });

  it.each(cassettes.map((cassette) => [cassette.id, cassette] as const))(
    "%s gives the reply and tool calls it gave when recorded",
    async (id, cassette) => {
      // Test data is built relative to today, so the day is put back.
      InvoiceBuddyAgent.clock = () =>
        new Date(`${cassette.recordedOn}T12:00:00Z`);
      const result = await replay(
        `cassette-${id}`,
        cassette.scenario,
        cassette.question,
        () => cassette.calls
      );
      expect(result.tools).toEqual(cassette.tools);
      expect(result.reply).toBe(cassette.reply);
    }
  );
});

describe("createModel for the smoke-test instance", () => {
  type Run = { model: string; options: unknown };

  function fakeEnv(vars: Record<string, string>) {
    const runs: Run[] = [];
    const AI = {
      run: async (model: string, _inputs: unknown, options: unknown) => {
        runs.push({ model, options });
        return new Response(answer("ok").chunks.join("")).body;
      }
    };
    return { runs, env: { ...env, ...vars, AI } as unknown as Env };
  }

  async function ask(model: LanguageModel): Promise<string> {
    return await streamText({ model, prompt: "Say ok." }).text;
  }

  it("records the raw stream locally when recording is on", async () => {
    const { env: local } = fakeEnv({
      ENVIRONMENT: "local",
      RECORD_MODEL_CALLS: "1"
    });
    const recorded: RecordedCall[] = [];
    const model = createModel(local, {
      smoke: true,
      onRecordedCall: (call) => recorded.push(call)
    });
    expect(await ask(model)).toBe("ok");
    expect(recorded).toHaveLength(1);
    // The recording is the raw stream: the text is still there twice.
    expect(recorded[0]?.chunks.join("")).toContain('"response":"ok"');
  });

  it("records nothing for an owner's instance", async () => {
    const { env: local } = fakeEnv({
      ENVIRONMENT: "local",
      RECORD_MODEL_CALLS: "1"
    });
    const recorded: RecordedCall[] = [];
    const model = createModel(local, {
      smoke: false,
      onRecordedCall: (call) => recorded.push(call)
    });
    await ask(model);
    expect(recorded).toEqual([]);
  });

  it("sends the deployed smoke instance's calls to the cheaper model through the cached gateway", async () => {
    const { env: staging, runs } = fakeEnv({
      ENVIRONMENT: "staging",
      SMOKE_MODEL_ID: PLUMBING_MODEL_ID,
      AI_GATEWAY_ID: "invoice-buddy-smoke"
    });
    expect(await ask(createModel(staging, { smoke: true }))).toBe("ok");
    expect(runs[0]?.model).toBe(PLUMBING_MODEL_ID);
    expect(runs[0]?.options).toMatchObject({
      gateway: { id: "invoice-buddy-smoke", cacheTtl: 3_600 }
    });
  });

  it("sends an owner's calls straight to the chat model", async () => {
    const { env: staging, runs } = fakeEnv({
      ENVIRONMENT: "staging",
      SMOKE_MODEL_ID: PLUMBING_MODEL_ID,
      AI_GATEWAY_ID: "invoice-buddy-smoke"
    });
    await ask(createModel(staging));
    expect(runs[0]?.model).toBe(CHAT_MODEL_ID);
    expect(JSON.stringify(runs[0]?.options ?? {})).not.toContain("gateway");
  });
});

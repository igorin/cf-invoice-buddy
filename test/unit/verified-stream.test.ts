import { describe, expect, it } from "vitest";
import {
  UNVERIFIED_MESSAGE,
  holdTextUntilChecked,
  type StreamChunk,
  type TurnForReview
} from "../../src/domain/verified-stream";

function streamOf(chunks: StreamChunk[]): ReadableStream<StreamChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
}

async function collect(
  stream: ReadableStream<StreamChunk>
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

const text = (id: string, ...deltas: string[]): StreamChunk[] => [
  { type: "text-start", id },
  ...deltas.map((delta) => ({ type: "text-delta", id, delta })),
  { type: "text-end", id }
];

const toolStep: StreamChunk[] = [
  { type: "start-step" },
  {
    type: "tool-input-available",
    toolCallId: "c1",
    toolName: "explainBillChange",
    input: {}
  },
  {
    type: "tool-output-available",
    toolCallId: "c1",
    output: { total: "$217.00" }
  },
  { type: "finish-step" }
];

type Options = Parameters<typeof holdTextUntilChecked>[1];

async function run(chunks: StreamChunk[], overrides: Partial<Options> = {}) {
  const reviewed: TurnForReview[] = [];
  const reported: unknown[] = [];
  const output = await collect(
    holdTextUntilChecked(streamOf(chunks), {
      review: (turn) => {
        reviewed.push(turn);
        return [];
      },
      onViolation: (violations) => reported.push(violations),
      ...overrides
    })
  );
  const shownText = output
    .filter((chunk) => chunk.type === "text-delta")
    .map((chunk) => String(chunk.delta))
    .join("");
  return {
    output,
    reviewed,
    reported,
    shownText,
    types: output.map((c) => c.type)
  };
}

const answer = [
  { type: "start" },
  ...toolStep,
  { type: "start-step" },
  ...text("t1", "Your bill ", "is $217.00."),
  { type: "finish-step" },
  { type: "finish" }
];

describe("holdTextUntilChecked", () => {
  it("shows a verified answer whole, as one piece, at the end of the turn", async () => {
    const { types, shownText } = await run(answer);
    expect(shownText).toBe("Your bill is $217.00.");
    expect(types).toEqual([
      "start",
      "start-step",
      "tool-input-available",
      "tool-output-available",
      "finish-step",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish"
    ]);
  });

  it("lets tool results through at once, before any text is released", async () => {
    const { types } = await run(answer);
    expect(types.indexOf("tool-output-available")).toBeLessThan(
      types.indexOf("text-start")
    );
  });

  it("gives the checker the whole text and every tool result of the turn", async () => {
    const { reviewed } = await run(answer);
    expect(reviewed).toEqual([
      {
        text: "Your bill is $217.00.",
        tools: [{ name: "explainBillChange", output: { total: "$217.00" } }]
      }
    ]);
  });

  it("replaces an answer that fails the check and reports why", async () => {
    const violations = [
      { rule: "G-1", detail: "figures not in any tool result: $412.00" }
    ];
    const { shownText, reported } = await run(answer, {
      review: () => violations
    });
    expect(shownText).toBe(UNVERIFIED_MESSAGE);
    expect(reported).toEqual([violations]);
  });

  it("never lets a word of an unverified answer through", async () => {
    const { output } = await run(answer, {
      review: () => [{ rule: "G-1", detail: "x" }]
    });
    expect(JSON.stringify(output)).not.toContain("Your bill");
  });

  it("joins text from several steps and checks it as one answer", async () => {
    const chunks = [
      { type: "start" },
      { type: "start-step" },
      ...text("t1", "Let me check."),
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "getUsageSummary",
        input: {}
      },
      { type: "tool-output-available", toolCallId: "c1", output: {} },
      { type: "finish-step" },
      { type: "start-step" },
      ...text("t2", "You used 311 neurons."),
      { type: "finish-step" },
      { type: "finish" }
    ];
    const { reviewed, shownText, types } = await run(chunks);
    expect(reviewed[0]?.text).toBe("Let me check.\n\nYou used 311 neurons.");
    expect(shownText).toBe("Let me check.\n\nYou used 311 neurons.");
    expect(types.filter((type) => type === "text-start")).toHaveLength(1);
  });

  it("ignores a tool's preliminary results", async () => {
    const chunks = [
      { type: "start-step" },
      {
        type: "tool-input-available",
        toolCallId: "c1",
        toolName: "x",
        input: {}
      },
      {
        type: "tool-output-available",
        toolCallId: "c1",
        output: { partial: true },
        preliminary: true
      },
      {
        type: "tool-output-available",
        toolCallId: "c1",
        output: { final: true }
      },
      ...text("t1", "Done."),
      { type: "finish-step" },
      { type: "finish" }
    ];
    const { reviewed } = await run(chunks);
    expect(reviewed[0]?.tools).toEqual([
      { name: "x", output: { final: true } }
    ]);
  });

  it("does not run the check, or add text, when the model wrote nothing", async () => {
    const { reviewed, types } = await run([
      { type: "start" },
      ...toolStep,
      { type: "finish" }
    ]);
    expect(reviewed).toEqual([]);
    expect(types).not.toContain("text-start");
    expect(types.at(-1)).toBe("finish");
  });

  it("passes an error through and releases no text", async () => {
    const chunks = [
      { type: "start" },
      { type: "start-step" },
      ...text("t1", "Half an ans"),
      { type: "error", errorText: "upstream failed" }
    ];
    const { types, shownText } = await run(chunks);
    expect(types).toContain("error");
    expect(shownText).toBe("");
  });

  it("closes cleanly when the stream ends without finishing", async () => {
    const { types, shownText } = await run([
      { type: "start" },
      { type: "start-step" },
      ...text("t1", "Cut off"),
      { type: "finish-step" }
    ]);
    expect(types).toEqual(["start", "start-step", "finish-step"]);
    expect(shownText).toBe("");
  });

  it("works with an answer that has no steps around it", async () => {
    const { shownText, types } = await run([
      ...text("t1", "Hello."),
      { type: "finish" }
    ]);
    expect(shownText).toBe("Hello.");
    expect(types.at(-1)).toBe("finish");
  });
});

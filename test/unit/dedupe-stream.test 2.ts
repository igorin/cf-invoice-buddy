import { describe, expect, it } from "vitest";
import {
  dedupeSseStream,
  dropDuplicateText,
  withDedupedStream
} from "../../src/domain/dedupe-stream";

const both = (text: string) =>
  JSON.stringify({ response: text, choices: [{ delta: { content: text } }] });

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

const encode = (text: string) => new TextEncoder().encode(text);

describe("dropDuplicateText (B8)", () => {
  it("removes the response field when the choices delta carries the same text", () => {
    const result = JSON.parse(dropDuplicateText(both("Hello")));
    expect(result).toEqual({ choices: [{ delta: { content: "Hello" } }] });
  });

  it("keeps a chunk that has only the response field", () => {
    const chunk = JSON.stringify({ response: "Hello" });
    expect(dropDuplicateText(chunk)).toBe(chunk);
  });

  it("keeps a chunk that has only the choices delta", () => {
    const chunk = JSON.stringify({ choices: [{ delta: { content: "Hi" } }] });
    expect(dropDuplicateText(chunk)).toBe(chunk);
  });

  it("keeps both fields when their texts differ", () => {
    const chunk = JSON.stringify({
      response: "a",
      choices: [{ delta: { content: "b" } }]
    });
    expect(dropDuplicateText(chunk)).toBe(chunk);
  });

  it("keeps a chunk whose response is empty", () => {
    const chunk = JSON.stringify({
      response: "",
      choices: [{ delta: { content: "" } }]
    });
    expect(dropDuplicateText(chunk)).toBe(chunk);
  });

  it("preserves the other fields of a chunk it changes", () => {
    const chunk = JSON.stringify({
      response: "x",
      choices: [{ delta: { content: "x" }, finish_reason: null }],
      usage: { prompt_tokens: 3 }
    });
    expect(JSON.parse(dropDuplicateText(chunk))).toEqual({
      choices: [{ delta: { content: "x" }, finish_reason: null }],
      usage: { prompt_tokens: 3 }
    });
  });

  it.each([
    { response: "x", choices: ["x"] },
    { response: "x", choices: [{}] },
    { response: "x", choices: [{ delta: { content: 7 } }] },
    { response: "x", choices: [] },
    { response: 5, choices: [{ delta: { content: "x" } }] }
  ])("keeps a chunk with an unexpected shape: %j", (shape) => {
    const chunk = JSON.stringify(shape);
    expect(dropDuplicateText(chunk)).toBe(chunk);
  });

  it.each(["[DONE]", "not json", "42", "null", "[1,2]"])(
    "returns %s unchanged",
    (payload) => {
      expect(dropDuplicateText(payload)).toBe(payload);
    }
  );
});

describe("dedupeSseStream (B8)", () => {
  it("removes the duplicate from each event and keeps the stream format", async () => {
    const input = `data: ${both("Hello")}\n\ndata: ${both(" there")}\n\ndata: [DONE]\n\n`;
    const output = await readAll(dedupeSseStream(streamOf([encode(input)])));
    expect(output).toBe(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ delta: { content: " there" } }] })}\n\n` +
        "data: [DONE]\n\n"
    );
  });

  it("handles an event split across network chunks", async () => {
    const input = `data: ${both("Hello")}\n\n`;
    const bytes = encode(input);
    const parts = [bytes.slice(0, 9), bytes.slice(9, 30), bytes.slice(30)];
    const output = await readAll(dedupeSseStream(streamOf(parts)));
    expect(output).toBe(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`
    );
  });

  it("handles a multi-byte character split across network chunks", async () => {
    const bytes = encode(`data: ${both("café ☁")}\n\n`);
    const cut = bytes.indexOf(0xe2) + 1; // inside the cloud character
    const output = await readAll(
      dedupeSseStream(streamOf([bytes.slice(0, cut), bytes.slice(cut)]))
    );
    expect(output).toContain('"content":"café ☁"');
    expect(output).not.toContain('"response"');
  });

  it("passes through lines that are not data events", async () => {
    const input = `: keep-alive\nevent: message\ndata: ${both("x")}\n\n`;
    const output = await readAll(dedupeSseStream(streamOf([encode(input)])));
    expect(output.startsWith(": keep-alive\nevent: message\ndata: ")).toBe(
      true
    );
  });

  it("keeps carriage returns in line endings", async () => {
    const input = `data: ${both("x")}\r\n\r\n`;
    const output = await readAll(dedupeSseStream(streamOf([encode(input)])));
    expect(output).toBe(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\r\n\r\n`
    );
  });

  it("emits a final line that has no trailing newline", async () => {
    const input = `data: ${both("end")}`;
    const output = await readAll(dedupeSseStream(streamOf([encode(input)])));
    expect(output).toBe(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "end" } }] })}`
    );
  });

  it("produces an empty stream from an empty stream", async () => {
    expect(await readAll(dedupeSseStream(streamOf([])))).toBe("");
  });
});

describe("token usage survives the wrapper (UC-8)", () => {
  // Shape of the final chunks Workers AI sent for a real Llama 3.3 call.
  const usage = {
    prompt_tokens: 41,
    completion_tokens: 2,
    total_tokens: 43,
    prompt_tokens_details: { cached_tokens: 0 },
    neurons: 1.5029851198196411
  };

  it("passes a usage-only chunk through byte for byte", async () => {
    const input = `data: ${JSON.stringify({ response: "", usage })}\n\ndata: [DONE]\n\n`;
    const output = await readAll(dedupeSseStream(streamOf([encode(input)])));
    expect(output).toBe(input);
  });

  it("keeps usage unchanged on a chunk whose duplicate text is removed", () => {
    const chunk = JSON.stringify({
      response: "ok",
      choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
      usage
    });
    expect(JSON.parse(dropDuplicateText(chunk)).usage).toEqual(usage);
  });

  it("keeps every usage figure across a whole stream", async () => {
    const input =
      `data: ${both("Hello")}\n\n` +
      `data: ${JSON.stringify({ response: "", choices: [{ delta: {}, finish_reason: "stop" }], usage })}\n\n` +
      "data: [DONE]\n\n";
    const output = await readAll(dedupeSseStream(streamOf([encode(input)])));
    const events = output
      .split("\n\n")
      .filter((event) => event.startsWith("data: {"))
      .map((event) => JSON.parse(event.slice("data: ".length)));
    expect(events.at(-1).usage).toEqual(usage);
  });
});

describe("withDedupedStream (B8)", () => {
  it("dedupes a streamed result from run", async () => {
    const binding = {
      run: async () => streamOf([encode(`data: ${both("Hi")}\n\n`)])
    };
    const result = await withDedupedStream(binding).run();
    expect(await readAll(result)).not.toContain('"response"');
  });

  it("returns a non-stream result from run untouched", async () => {
    const reply = { response: "Hi", usage: { prompt_tokens: 1 } };
    const binding = { run: async (): Promise<unknown> => reply };
    expect(await withDedupedStream(binding).run()).toBe(reply);
  });

  it("passes arguments through to run", async () => {
    const seen: unknown[] = [];
    const binding = {
      run: async (...args: unknown[]): Promise<unknown> => {
        seen.push(...args);
        return null;
      }
    };
    await withDedupedStream(binding).run("model", { stream: true });
    expect(seen).toEqual(["model", { stream: true }]);
  });

  it("leaves the binding's other members reachable", () => {
    const binding = { run: async (): Promise<unknown> => null, gateway: "g" };
    expect(withDedupedStream(binding).gateway).toBe("g");
  });
});

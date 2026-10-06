import { describe, expect, it } from "vitest";
import {
  replayBinding,
  withRecording,
  type RecordedCall
} from "../../src/domain/model-recording";

const encoder = new TextEncoder();

function streamOf(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    }
  });
}

async function read(stream: unknown): Promise<string> {
  return await new Response(stream as ReadableStream<Uint8Array>).text();
}

describe("withRecording", () => {
  it("passes the stream through unchanged and reports it when it ends", async () => {
    const calls: RecordedCall[] = [];
    const binding = withRecording(
      {
        run: async () =>
          streamOf([
            encoder.encode("data: a\n\n"),
            encoder.encode("data: b\n\n")
          ])
      },
      (call) => calls.push(call)
    );
    const stream = await binding.run();
    expect(calls).toEqual([]);
    expect(await read(stream)).toBe("data: a\n\ndata: b\n\n");
    expect(calls).toEqual([{ chunks: ["data: a\n\n", "data: b\n\n"] }]);
  });

  it("keeps a character whole when it arrives split across two chunks", async () => {
    const calls: RecordedCall[] = [];
    const bytes = encoder.encode("café ☁");
    const binding = withRecording(
      { run: async () => streamOf([bytes.slice(0, 4), bytes.slice(4)]) },
      (call) => calls.push(call)
    );
    await read(await binding.run());
    expect(calls[0]?.chunks.join("")).toBe("café ☁");
  });

  it("reports one recording for each call, in order", async () => {
    const calls: RecordedCall[] = [];
    let count = 0;
    const binding = withRecording(
      {
        run: async () => {
          count += 1;
          return streamOf([encoder.encode(`call ${count}`)]);
        }
      },
      (call) => calls.push(call)
    );
    await read(await binding.run());
    await read(await binding.run());
    expect(calls.map((call) => call.chunks.join(""))).toEqual([
      "call 1",
      "call 2"
    ]);
  });

  it("leaves a result that is not a stream alone and records nothing", async () => {
    const calls: RecordedCall[] = [];
    const binding = withRecording(
      { run: async () => ({ response: "hi" }) },
      (call) => calls.push(call)
    );
    expect(await binding.run()).toEqual({ response: "hi" });
    expect(calls).toEqual([]);
  });

  it("leaves the binding's other members alone", () => {
    const binding = withRecording(
      { run: async () => null, gateway: "kept" },
      () => undefined
    );
    expect(binding.gateway).toBe("kept");
  });
});

describe("replayBinding", () => {
  it("returns each recorded stream in turn", async () => {
    const binding = replayBinding([
      { chunks: ["data: one\n\n", "data: [DONE]\n\n"] },
      { chunks: ["data: two\n\n"] }
    ]);
    expect(await read(await binding.run())).toBe(
      "data: one\n\ndata: [DONE]\n\n"
    );
    expect(await read(await binding.run())).toBe("data: two\n\n");
  });

  it("fails when the turn asks for more calls than were recorded", async () => {
    const binding = replayBinding([{ chunks: ["x"] }]);
    await binding.run();
    await expect(binding.run()).rejects.toThrow(
      "The recording holds 1 model calls and the turn asked for another."
    );
  });

  it("plays back exactly what a recording captured", async () => {
    const calls: RecordedCall[] = [];
    const original = 'data: {"response":"é"}\n\ndata: [DONE]\n\n';
    const bytes = encoder.encode(original);
    const recording = withRecording(
      { run: async () => streamOf([bytes.slice(0, 20), bytes.slice(20)]) },
      (call) => calls.push(call)
    );
    await read(await recording.run());
    expect(await read(await replayBinding(calls).run())).toBe(original);
  });
});

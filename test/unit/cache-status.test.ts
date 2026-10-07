import { describe, expect, it } from "vitest";
import {
  CACHE_STATUS_HEADER,
  isCacheHit,
  withCacheStatus
} from "../../src/domain/cache-status";
import { billedUsage } from "../../src/domain/self-cost";

describe("isCacheHit", () => {
  it("is true only for an explicit hit", () => {
    expect(isCacheHit("HIT")).toBe(true);
    expect(isCacheHit(" hit ")).toBe(true);
  });

  it.each(["MISS", "BYPASS", "EXPIRED", "STALE", "HITS", "", "true", "1"])(
    "counts %j as usage",
    (status) => {
      expect(isCacheHit(status)).toBe(false);
    }
  );

  it("counts a missing value as usage", () => {
    expect(isCacheHit(null)).toBe(false);
    expect(isCacheHit(undefined)).toBe(false);
  });
});

type Call = { model: unknown; inputs: unknown; options: unknown };

function fakeBinding(reply: (call: Call) => unknown) {
  const calls: Call[] = [];
  const binding = {
    marker: "kept",
    run: async (model: unknown, inputs: unknown, options?: unknown) => {
      const call = { model, inputs, options };
      calls.push(call);
      return reply(call);
    }
  };
  return { binding, calls };
}

const sse = (status: string | null, init: ResponseInit = {}) =>
  new Response("data: [DONE]\n\n", {
    ...init,
    headers: {
      "content-type": "text/event-stream",
      ...(status === null ? {} : { [CACHE_STATUS_HEADER]: status })
    }
  });

const STREAMING = { messages: [], stream: true };

async function run(
  reply: (call: Call) => unknown,
  inputs: unknown = STREAMING,
  options: unknown = { gateway: { id: "g" } }
) {
  const seen: boolean[] = [];
  const { binding, calls } = fakeBinding(reply);
  const wrapped = withCacheStatus(binding, (hit) => seen.push(hit));
  const outcome = await wrapped
    .run("model", inputs, options)
    .then((value) => ({ value, error: null as unknown }))
    .catch((error: unknown) => ({ value: null as unknown, error }));
  return { ...outcome, seen, calls };
}

describe("withCacheStatus", () => {
  it("reports a hit and hands on the stream, as the binding would have", async () => {
    const { value, seen, calls } = await run(() => sse("HIT"));
    expect(seen).toEqual([true]);
    expect(value).toBeInstanceOf(ReadableStream);
    expect(await new Response(value as ReadableStream).text()).toBe(
      "data: [DONE]\n\n"
    );
    expect(calls[0]?.options).toEqual({
      gateway: { id: "g" },
      returnRawResponse: true
    });
  });

  it.each(["MISS", "BYPASS", null])(
    "reports a call whose status is %j as usage",
    async (status) => {
      const { seen, value } = await run(() => sse(status));
      expect(seen).toEqual([false]);
      expect(value).toBeInstanceOf(ReadableStream);
    }
  );

  it("counts the call as usage when the binding returns only a stream", async () => {
    const stream = new Response("x").body;
    const { seen, value } = await run(() => stream);
    expect(seen).toEqual([false]);
    expect(value).toBe(stream);
  });

  it("throws on a failed call, with the error text, and counts it as usage", async () => {
    const { error, seen } = await run(() =>
      sse("HIT", { status: 429 }).clone()
    ).then(async (outcome) => outcome);
    expect(seen).toEqual([false]);
    expect(String(error)).toContain("429: data: [DONE]");
  });

  it("keeps Cloudflare's allowance message in the error", async () => {
    const body =
      '{"errors":[{"code":4006,"message":"you have used up your daily free allocation of 10,000 neurons"}]}';
    const { error } = await run(() => new Response(body, { status: 429 }));
    expect(String(error)).toMatch(/4006|daily free allocation/);
  });

  it("leaves a call that does not stream alone and counts it as usage", async () => {
    const { seen, value, calls } = await run(() => ({ response: "hi" }), {
      messages: []
    });
    expect(seen).toEqual([false]);
    expect(value).toEqual({ response: "hi" });
    expect(calls[0]?.options).toEqual({ gateway: { id: "g" } });
  });

  it("leaves a call alone when the caller asked for the whole response itself", async () => {
    const response = sse("HIT");
    const { seen, value } = await run(() => response, STREAMING, {
      returnRawResponse: true
    });
    expect(seen).toEqual([false]);
    expect(value).toBe(response);
  });

  it("works when the call has no options", async () => {
    const seen: boolean[] = [];
    const { binding, calls } = fakeBinding(() => sse("HIT"));
    await withCacheStatus(binding, (hit) => seen.push(hit)).run(
      "model",
      STREAMING
    );
    expect(seen).toEqual([true]);
    expect(calls[0]?.options).toEqual({ returnRawResponse: true });
  });

  it("leaves the binding's other members alone", () => {
    const { binding } = fakeBinding(() => null);
    expect(withCacheStatus(binding, () => undefined).marker).toBe("kept");
  });
});

describe("billedUsage", () => {
  const steps = [
    { inputTokens: 900, outputTokens: 12 },
    { inputTokens: 1400, outputTokens: 20 }
  ];

  it("counts every call when none came from the cache", () => {
    expect(billedUsage(steps, [false, false])).toEqual({
      inputTokens: 2300,
      outputTokens: 32,
      steps: 2,
      cachedSteps: 0
    });
  });

  it("leaves out the calls the cache served", () => {
    expect(billedUsage(steps, [true, false])).toEqual({
      inputTokens: 1400,
      outputTokens: 20,
      steps: 2,
      cachedSteps: 1
    });
  });

  it("counts nothing for a turn served wholly from the cache", () => {
    expect(billedUsage(steps, [true, true])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      steps: 2,
      cachedSteps: 2
    });
  });

  it.each([[[]], [[true]], [[true, true, true]]])(
    "counts the whole turn when the cache record does not line up with the calls (%j)",
    (hits) => {
      expect(billedUsage(steps, hits)).toEqual({
        inputTokens: 2300,
        outputTokens: 32,
        steps: 2,
        cachedSteps: 0
      });
    }
  );

  it("leaves a turn unmetered when a billed call has no token count", () => {
    const usage = billedUsage(
      [{ inputTokens: undefined, outputTokens: undefined }, steps[1] ?? {}],
      [false, false]
    );
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.cachedSteps).toBe(0);
  });

  it("ignores a missing token count on a call the cache served", () => {
    const usage = billedUsage(
      [{ inputTokens: undefined, outputTokens: undefined }, steps[1] ?? {}],
      [true, false]
    );
    expect(usage).toMatchObject({ inputTokens: 1400, cachedSteps: 1 });
  });

  it("reports a turn with no model call as unmetered", () => {
    expect(billedUsage([], [])).toEqual({
      inputTokens: undefined,
      outputTokens: undefined,
      steps: 0,
      cachedSteps: 0
    });
  });
});

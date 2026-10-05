/**
 * Workaround for spec defect B8. With Llama 3.3, each streamed chunk from
 * Workers AI carries its text twice: in `response` and in
 * `choices[0].delta.content`. The provider emits both, so every word reaches
 * the client twice. This removes `response` from a chunk only when both
 * fields hold the same text, and is a no-op otherwise. Delete it once the
 * provider or the stream is fixed.
 */

const SSE_DATA_PREFIX = /^data: ?/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChoiceText(chunk: Record<string, unknown>): string | undefined {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) return undefined;
  const content = first.delta.content;
  return typeof content === "string" ? content : undefined;
}

/** Returns the chunk JSON without `response` when the choices delta repeats it. */
export function dropDuplicateText(payload: string): string {
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isRecord(chunk)) return payload;

  const response = chunk.response;
  if (typeof response !== "string" || response === "") return payload;
  if (readChoiceText(chunk) !== response) return payload;

  const { response: _duplicate, ...rest } = chunk;
  return JSON.stringify(rest);
}

function rewriteLine(line: string): string {
  const carriageReturn = line.endsWith("\r") ? "\r" : "";
  const body = carriageReturn ? line.slice(0, -1) : line;
  const prefix = SSE_DATA_PREFIX.exec(body)?.[0];
  if (prefix === undefined) return line;
  return prefix + dropDuplicateText(body.slice(prefix.length)) + carriageReturn;
}

/** Applies `dropDuplicateText` to every `data:` line of a server-sent event stream. */
export function dedupeSseStream(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        pending += decoder.decode(bytes, { stream: true });
        const lastBreak = pending.lastIndexOf("\n");
        if (lastBreak === -1) return;
        const complete = pending.slice(0, lastBreak);
        pending = pending.slice(lastBreak + 1);
        const rewritten = complete
          .split("\n")
          .map((line) => rewriteLine(line) + "\n");
        controller.enqueue(encoder.encode(rewritten.join("")));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending !== "")
          controller.enqueue(encoder.encode(rewriteLine(pending)));
      }
    })
  );
}

/**
 * Wraps an AI binding so streamed results of `run` are de-duplicated.
 * Non-stream results and every other member pass through unchanged.
 */
export function withDedupedStream<
  T extends { run: (...args: never[]) => Promise<unknown> }
>(binding: T): T {
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property !== "run") return Reflect.get(target, property, receiver);
      return async (...args: never[]) => {
        const result = await target.run(...args);
        return result instanceof ReadableStream
          ? dedupeSseStream(result as ReadableStream<Uint8Array>)
          : result;
      };
    }
  });
}

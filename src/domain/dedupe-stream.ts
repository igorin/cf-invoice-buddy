/**
 * Workaround for spec defect B8. With Llama 3.3, each streamed chunk from
 * Workers AI carries its text twice: in `response` and in
 * `choices[0].delta.content`. The provider emits both, so every word reaches
 * the client twice. The same happens to streamed tool calls, which arrive
 * in `tool_calls` and in `choices[0].delta.tool_calls`; joined, their
 * arguments are invalid JSON. This removes the top-level copy only when the
 * choices delta carries the same thing, and is a no-op otherwise. Delete it once the
 * provider or the stream is fixed.
 */

const SSE_DATA_PREFIX = /^data: ?/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChoiceText(chunk: Record<string, unknown>): string | undefined {
  const content = firstChoiceDelta(chunk)?.content;
  return typeof content === "string" ? content : undefined;
}

/**
 * Whether `response` carries the same token as the choices delta. A numeric
 * token arrives as a JSON number in `response` and as text in the delta, so
 * numbers are compared by value ("1.50" and 1.5 are the same token).
 */
function repeatsChoiceText(
  response: unknown,
  choiceText: string | undefined
): boolean {
  if (choiceText === undefined) return false;
  if (typeof response === "string") {
    return response !== "" && response === choiceText;
  }
  if (typeof response === "number") {
    return choiceText.trim() !== "" && Number(choiceText) === response;
  }
  return false;
}

function firstChoiceDelta(
  chunk: Record<string, unknown>
): Record<string, unknown> | undefined {
  const choices = chunk.choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  return isRecord(first) && isRecord(first.delta) ? first.delta : undefined;
}

const isNonEmptyArray = (value: unknown): boolean =>
  Array.isArray(value) && value.length > 0;

/**
 * Returns the chunk JSON without the top-level copies of what the choices
 * delta already carries: `response` for a text token and `tool_calls` for a
 * tool call. Anything else is returned unchanged.
 */
export function dropDuplicateText(payload: string): string {
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isRecord(chunk)) return payload;

  const delta = firstChoiceDelta(chunk);
  const repeatsText = repeatsChoiceText(chunk.response, readChoiceText(chunk));
  const repeatsToolCall =
    isNonEmptyArray(chunk.tool_calls) && isNonEmptyArray(delta?.tool_calls);
  if (!repeatsText && !repeatsToolCall) return payload;

  // A fresh copy, so the parsed chunk itself is not changed.
  const result = { ...chunk };
  if (repeatsText) delete result.response;
  if (repeatsToolCall) delete result.tool_calls;
  return JSON.stringify(result);
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

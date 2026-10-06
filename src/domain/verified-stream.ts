/**
 * Holds the model's text back until it has been checked (spec section 7).
 *
 * Tool results pass straight through, so the cards built from them appear
 * at once. The text is collected for the whole turn, checked against those
 * results, and released in one piece at the end. An answer that fails the
 * check is never shown: a fixed line takes its place.
 */

export const UNVERIFIED_MESSAGE =
  "I couldn't produce an answer I could verify against your account data. Any card above shows the figures from your account. Please ask again if you need more.";

/** A chunk of the UI message stream. Only the fields used here are named. */
export type StreamChunk = Readonly<{ type: string; [key: string]: unknown }>;

export type TurnForReview = Readonly<{
  text: string;
  tools: ReadonlyArray<Readonly<{ name: string; output: unknown }>>;
}>;

export type HoldOptions<V> = Readonly<{
  /** Returns the breaches found in the turn; none means the text may be shown. */
  review: (turn: TurnForReview) => ReadonlyArray<V>;
  onViolation: (violations: ReadonlyArray<V>) => void;
}>;

const TEXT_CHUNKS = new Set(["text-start", "text-delta", "text-end"]);

export function holdTextUntilChecked<V>(
  source: ReadableStream<StreamChunk>,
  options: HoldOptions<V>
): ReadableStream<StreamChunk> {
  const blocks: string[] = [];
  const toolNames = new Map<string, string>();
  const tools: Array<{ name: string; output: unknown }> = [];
  // A step's end is held until it is known whether the turn ends with it,
  // so the checked text can be placed inside the last step.
  let heldStepEnd: StreamChunk | null = null;
  let failed = false;

  const releaseStepEnd = (
    controller: TransformStreamDefaultController<StreamChunk>
  ) => {
    if (heldStepEnd) controller.enqueue(heldStepEnd);
    heldStepEnd = null;
  };

  const releaseText = (
    controller: TransformStreamDefaultController<StreamChunk>
  ) => {
    const text = blocks
      .map((block) => block.trim())
      .filter((block) => block !== "")
      .join("\n\n");
    if (text === "") return;
    const violations = options.review({ text, tools });
    if (violations.length > 0) options.onViolation(violations);
    const id = crypto.randomUUID();
    controller.enqueue({ type: "text-start", id });
    controller.enqueue({
      type: "text-delta",
      id,
      delta: violations.length > 0 ? UNVERIFIED_MESSAGE : text
    });
    controller.enqueue({ type: "text-end", id });
  };

  return source.pipeThrough(
    new TransformStream<StreamChunk, StreamChunk>({
      transform(chunk, controller) {
        if (TEXT_CHUNKS.has(chunk.type)) {
          if (chunk.type === "text-start") blocks.push("");
          if (chunk.type === "text-delta") {
            blocks[blocks.length - 1] =
              `${blocks.at(-1) ?? ""}${String(chunk.delta ?? "")}`;
          }
          return;
        }
        if (chunk.type === "finish-step") {
          releaseStepEnd(controller);
          heldStepEnd = chunk;
          return;
        }
        if (chunk.type === "finish") {
          if (!failed) releaseText(controller);
          releaseStepEnd(controller);
          controller.enqueue(chunk);
          return;
        }
        releaseStepEnd(controller);
        if (chunk.type === "error") failed = true;
        if (chunk.type === "tool-input-available") {
          toolNames.set(String(chunk.toolCallId), String(chunk.toolName));
        }
        if (
          chunk.type === "tool-output-available" &&
          chunk.preliminary !== true
        ) {
          tools.push({
            name: toolNames.get(String(chunk.toolCallId)) ?? "",
            output: chunk.output
          });
        }
        controller.enqueue(chunk);
      },
      flush(controller) {
        // The stream ended without finishing: nothing unchecked is released.
        releaseStepEnd(controller);
      }
    })
  );
}

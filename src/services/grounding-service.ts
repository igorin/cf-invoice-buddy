import {
  createUIMessageStreamResponse,
  type UIMessage,
  type UIMessageChunk
} from "ai";
import { checkGrounding, type Violation } from "../domain/grounding";
import {
  holdTextUntilChecked,
  type StreamChunk,
  type TurnForReview
} from "../domain/verified-stream";

/**
 * Runs the response checker over a turn before its text is shown (spec
 * section 7): compares the text with the results of the turn's tools.
 */

/** Links the app itself gives, which need no documentation search. */
export const ALLOWED_URLS = [
  "https://developers.cloudflare.com/support/contacting-cloudflare-support/"
] as const;

const DOCS_TOOL = "searchCloudflareDocs";
const EXPLAIN_TOOL = "explainBillChange";
const PLANS_TOOL = "comparePlans";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (message: UIMessage | undefined): string =>
  (message?.parts ?? [])
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ");

function docsUrlsIn(output: unknown): string[] {
  if (!isRecord(output) || !Array.isArray(output.results)) return [];
  return output.results.flatMap((result) =>
    isRecord(result) && typeof result.url === "string" ? [result.url] : []
  );
}

export function reviewTurn(
  turn: TurnForReview,
  conversation: ReadonlyArray<UIMessage>
): Violation[] {
  const ownerMessage = conversation
    .filter((message) => message.role === "user")
    .at(-1);
  const explain = turn.tools.find((tool) => tool.name === EXPLAIN_TOOL)?.output;
  return checkGrounding({
    text: turn.text,
    toolResults: turn.tools.map((tool) => tool.output),
    ownerText: textOf(ownerMessage),
    docsUrls: turn.tools
      .filter((tool) => tool.name === DOCS_TOOL)
      .flatMap((tool) => docsUrlsIn(tool.output)),
    allowedUrls: ALLOWED_URLS,
    estimateRequired: turn.tools.some((tool) => tool.name === PLANS_TOOL),
    explainOutcome:
      isRecord(explain) && typeof explain.outcome === "string"
        ? explain.outcome
        : null
  });
}

/**
 * Turns a model stream into the chat response. No text reaches the owner
 * before the checker has passed it; tool results go straight through, so
 * the cards built from them appear at once.
 */
export function checkedResponse(
  stream: ReadableStream<UIMessageChunk>,
  conversation: ReadonlyArray<UIMessage>,
  onViolation: (violations: ReadonlyArray<Violation>) => void
): Response {
  const checked = holdTextUntilChecked(stream as ReadableStream<StreamChunk>, {
    review: (turn) => reviewTurn(turn, conversation),
    onViolation
  });
  return createUIMessageStreamResponse({
    stream: checked as ReadableStream<UIMessageChunk>
  });
}

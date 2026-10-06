import type { UIMessage } from "ai";
import { checkGrounding, type Violation } from "../domain/grounding";

/**
 * Runs the response checker over a finished reply (spec section 7): pulls
 * the turn's tool results out of the message and compares the text with them.
 */

/** Links the app itself gives, which need no documentation search. */
export const ALLOWED_URLS = [
  "https://developers.cloudflare.com/support/contacting-cloudflare-support/"
] as const;

export const GROUNDING_NOTICE =
  "Part of the previous answer could not be verified against your account data. Rely on the figures in the cards, not on that answer.";

const DOCS_TOOL = "tool-searchCloudflareDocs";
const EXPLAIN_TOOL = "tool-explainBillChange";

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

export function reviewReply(
  reply: UIMessage,
  conversation: ReadonlyArray<UIMessage>
): Violation[] {
  const ownerMessage = conversation
    .filter((message) => message.role === "user")
    .at(-1);
  const outputs = reply.parts.flatMap((part) =>
    part.type.startsWith("tool-") &&
    "output" in part &&
    part.output !== undefined
      ? [{ type: part.type, output: part.output as unknown }]
      : []
  );
  const explain = outputs.find((entry) => entry.type === EXPLAIN_TOOL)?.output;
  return checkGrounding({
    text: textOf(reply),
    toolResults: outputs.map((entry) => entry.output),
    ownerText: textOf(ownerMessage),
    docsUrls: outputs
      .filter((entry) => entry.type === DOCS_TOOL)
      .flatMap((entry) => docsUrlsIn(entry.output)),
    allowedUrls: ALLOWED_URLS,
    explainOutcome:
      isRecord(explain) && typeof explain.outcome === "string"
        ? explain.outcome
        : null
  });
}

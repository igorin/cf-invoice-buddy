/**
 * A stand-in for the model, for browser tests (spec section 10). It answers
 * from a fixed script: it picks a tool from words in the owner's message,
 * and after the tool has run it writes a short line with no figures in it.
 * It never calls Workers AI. It can be switched on only in local
 * development (see model.ts).
 */

type Message = Readonly<{ role?: unknown; content?: unknown }>;

type ScriptedCall = Readonly<{ name: string; args: Record<string, unknown> }>;

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content ?? "");

/** The tool the script calls for an owner's message, if any. First match wins. */
export function scriptedToolFor(message: string): ScriptedCall | null {
  const text = message.toLowerCase();
  if (/test mode/.test(text)) {
    return {
      name: "setDataMode",
      args: { dataset: "test", scenario: "usage-spike" }
    };
  }
  if (/credit|refund/.test(text)) {
    return {
      name: "draftCreditRequest",
      args: { service: "Workers", ownerReason: message, replaceExisting: true }
    };
  }
  if (/\bclose\b/.test(text)) return { name: "startInvoiceClose", args: {} };
  if (/plan|cheaper/.test(text)) return { name: "comparePlans", args: {} };
  if (/assistant cost|cost me/.test(text)) {
    return { name: "getAssistantCost", args: {} };
  }
  if (/why|bill|higher|lower/.test(text)) {
    return { name: "explainBillChange", args: {} };
  }
  if (/used|usage/.test(text)) return { name: "getUsageSummary", args: {} };
  return null;
}

export const SCRIPTED_DECLINE = "I can only help with Cloudflare billing.";

/** What the script says once a tool has returned. It states no figure. */
export function scriptedReply(toolResult: string): string {
  const label = /TEST DATA/.test(toolResult) ? " This is test data." : "";
  return `Here is what the account's data shows. The details are in the card above.${label}`;
}

const event = (payload: unknown): string =>
  `data: ${JSON.stringify(payload)}\n\n`;

// Nominal counts, so a scripted turn is metered like any other.
const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function toolCallStream(call: ScriptedCall): string {
  return (
    event({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call-${crypto.randomUUID().slice(0, 8)}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.args)
                }
              }
            ]
          }
        }
      ]
    }) +
    event({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: USAGE
    }) +
    "data: [DONE]\n\n"
  );
}

function textStream(text: string): string {
  return (
    event({ choices: [{ delta: { content: text } }] }) +
    event({ choices: [{ delta: {}, finish_reason: "stop" }], usage: USAGE }) +
    "data: [DONE]\n\n"
  );
}

/** The stream the script produces for a conversation. */
export function scriptedStream(messages: ReadonlyArray<Message>): string {
  const last = messages.at(-1);
  if (last?.role === "tool")
    return textStream(scriptedReply(textOf(last.content)));
  const owner = messages.filter((message) => message.role === "user").at(-1);
  const call = scriptedToolFor(textOf(owner?.content));
  return call ? toolCallStream(call) : textStream(SCRIPTED_DECLINE);
}

/** Stands in for the Workers AI binding. */
export function scriptedBinding(): {
  run: (model: unknown, inputs: unknown) => Promise<ReadableStream<Uint8Array>>;
} {
  return {
    run: async (_model, inputs) => {
      const messages =
        typeof inputs === "object" &&
        inputs !== null &&
        Array.isArray((inputs as { messages?: unknown }).messages)
          ? (inputs as { messages: Message[] }).messages
          : [];
      const body = new TextEncoder().encode(scriptedStream(messages));
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        }
      });
    }
  };
}

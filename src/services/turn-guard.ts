import type { UIMessage } from "ai";
import { detectLoop, type StepSummary } from "../domain/loop-guard";

/**
 * Connects the loop guard to the AI SDK. A step's tool call counts as failed
 * when the SDK could not parse its input or the tool threw.
 */

type SdkStep = Readonly<{
  toolCalls: ReadonlyArray<
    Readonly<{
      toolCallId: string;
      toolName: string;
      input: unknown;
      invalid?: boolean;
    }>
  >;
  content: ReadonlyArray<Readonly<{ type: string; toolCallId?: string }>>;
}>;

function summarise(step: SdkStep): StepSummary {
  const errored = new Set(
    step.content
      .filter((part) => part.type === "tool-error")
      .map((part) => part.toolCallId)
  );
  return {
    calls: step.toolCalls.map((call) => ({
      tool: call.toolName,
      input: JSON.stringify(call.input ?? null),
      failed: call.invalid === true || errored.has(call.toolCallId)
    }))
  };
}

/** A stop condition for streamText: true once the turn is going in circles. */
export function isLooping({
  steps
}: {
  steps: ReadonlyArray<SdkStep>;
}): boolean {
  return detectLoop(steps.map(summarise)).loop;
}

/** Whether a finished assistant message gives the owner anything to read or act on. */
export function hasVisibleReply(message: UIMessage): boolean {
  return message.parts.some(
    (part) =>
      (part.type === "text" && part.text.trim() !== "") ||
      // A tool waiting for approval is shown as a prompt in the UI.
      ("state" in part && part.state === "approval-requested")
  );
}

/** Shown when Cloudflare refuses a model call because the free allowance is spent. */
export const ALLOWANCE_EXHAUSTED_MESSAGE =
  "Cloudflare's free daily allowance of model usage for this account is used up, so I can't answer right now. The usage summary still works. Cloudflare resets the allowance daily.";

export const TURN_FAILED_MESSAGE =
  "Something went wrong while answering. Please try again.";

// Workers AI error 4006, as returned on 2026-10-06: "you have used up your
// daily free allocation of 10,000 neurons".
const ALLOWANCE_ERROR = /\b4006\b|daily free allocation/i;

/** Turns a failed model call into a line the owner can act on. */
export function describeTurnError(message: string): string {
  return ALLOWANCE_ERROR.test(message)
    ? ALLOWANCE_EXHAUSTED_MESSAGE
    : TURN_FAILED_MESSAGE;
}

/**
 * The stream's error handler. Without it the owner sees only "An error
 * occurred." and nothing is logged. The message is logged, never the request.
 */
export function reportTurnError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Chat turn failed:", message.slice(0, 300));
  return describeTurnError(message);
}

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

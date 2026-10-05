/**
 * Detects a chat turn that is going round in circles, so it can be stopped
 * before it spends more model calls (spec NFR-O3, free-tier limit).
 */

export type StepSummary = Readonly<{
  calls: ReadonlyArray<
    Readonly<{ tool: string; input: string; failed: boolean }>
  >;
}>;

export type LoopCheck =
  | Readonly<{ loop: false }>
  | Readonly<{
      loop: true;
      reason: "repeated_tool_failure" | "repeated_identical_call";
    }>;

// One failed call may be the model correcting itself; two in a row is a loop.
const MAX_CONSECUTIVE_FAILED_STEPS = 2;
// The same call twice can be a retry; a third time will not go differently.
const MAX_IDENTICAL_CALLS = 3;

const hasFailure = (step: StepSummary): boolean =>
  step.calls.some((call) => call.failed);

export function detectLoop(steps: ReadonlyArray<StepSummary>): LoopCheck {
  const recent = steps.slice(-MAX_CONSECUTIVE_FAILED_STEPS);
  if (
    recent.length === MAX_CONSECUTIVE_FAILED_STEPS &&
    recent.every(hasFailure)
  ) {
    return { loop: true, reason: "repeated_tool_failure" };
  }

  const seen = new Map<string, number>();
  for (const step of steps) {
    for (const call of step.calls) {
      const key = `${call.tool}\u0000${call.input}`;
      const count = (seen.get(key) ?? 0) + 1;
      if (count >= MAX_IDENTICAL_CALLS) {
        return { loop: true, reason: "repeated_identical_call" };
      }
      seen.set(key, count);
    }
  }
  return { loop: false };
}

import { describe, expect, it } from "vitest";
import { detectLoop, type StepSummary } from "../../src/domain/loop-guard";

const call = (tool: string, input: string, failed = false) => ({
  tool,
  input,
  failed
});
const step = (...calls: ReturnType<typeof call>[]): StepSummary => ({ calls });

describe("detectLoop", () => {
  it("lets a normal turn through: one tool call, then the answer", () => {
    expect(detectLoop([step(call("getUsageSummary", "{}")), step()])).toEqual({
      loop: false
    });
  });

  it("allows one failed tool call, so the model can correct itself", () => {
    const steps = [step(call("explainBillChange", '{"month":"x"}', true))];
    expect(detectLoop(steps)).toEqual({ loop: false });
  });

  // Seen live on 2026-10-05: every explainBillChange call failed and the
  // model retried to the step limit, eight model calls for no answer.
  it("stops when two steps in a row end in a failed tool call", () => {
    const steps = [
      step(call("explainBillChange", '{"month":"a"}', true)),
      step(call("explainBillChange", '{"month":"b"}', true))
    ];
    expect(detectLoop(steps)).toEqual({
      loop: true,
      reason: "repeated_tool_failure"
    });
  });

  it("does not count failures that a success separates", () => {
    const steps = [
      step(call("explainBillChange", '{"month":"a"}', true)),
      step(call("getUsageSummary", "{}")),
      step(call("explainBillChange", '{"month":"b"}', true))
    ];
    expect(detectLoop(steps)).toEqual({ loop: false });
  });

  it("stops when the same call with the same input is made a third time", () => {
    const same = () => step(call("getUsageSummary", "{}"));
    expect(detectLoop([same(), same()])).toEqual({ loop: false });
    expect(detectLoop([same(), same(), same()])).toEqual({
      loop: true,
      reason: "repeated_identical_call"
    });
  });

  it("treats the same tool with different input as different calls", () => {
    const steps = ["2026-07", "2026-08", "2026-09"].map((month) =>
      step(call("explainBillChange", `{"baselineMonth":"${month}"}`))
    );
    expect(detectLoop(steps)).toEqual({ loop: false });
  });

  it("finds nothing in a turn with no steps", () => {
    expect(detectLoop([])).toEqual({ loop: false });
  });
});

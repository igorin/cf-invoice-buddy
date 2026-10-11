import { describe, expect, it } from "vitest";
import {
  MAX_WITHHELD_SHARE,
  RUNS,
  casePassed,
  judge,
  runCounts,
  shouldStop,
  type GradedRun
} from "../../evals/gate";

const pass: GradedRun = { passed: true, withheld: false };
const fail: GradedRun = { passed: false, withheld: false };
// The response checker held the reply back: nothing unverified was shown,
// and nothing useful either.
const withheld: GradedRun = { passed: false, withheld: true };

describe("a grounding run (NFR-T5)", () => {
  it("counts when its reply passed, or was withheld by the response checker", () => {
    expect(runCounts("grounding", pass)).toBe(true);
    expect(runCounts("grounding", withheld)).toBe(true);
  });

  it("does not count when a reply was shown and failed a check", () => {
    expect(runCounts("grounding", fail)).toBe(false);
  });

  it("stops the case at the first run that does not count, and not at a withheld one", () => {
    expect(shouldStop("grounding", fail)).toBe(true);
    expect(shouldStop("grounding", pass)).toBe(false);
    expect(shouldStop("grounding", withheld)).toBe(false);
  });
});

describe("a capability run", () => {
  it("counts only when its reply passed: a withheld reply did not do the job", () => {
    expect(runCounts("capability", pass)).toBe(true);
    expect(runCounts("capability", withheld)).toBe(false);
    expect(runCounts("capability", fail)).toBe(false);
  });

  it("stops the case at the first pass", () => {
    expect(shouldStop("capability", pass)).toBe(true);
    expect(shouldStop("capability", withheld)).toBe(false);
  });
});

describe("casePassed", () => {
  it("needs every one of the three grounding runs to count", () => {
    expect(casePassed("grounding", [pass, pass, pass])).toBe(true);
    expect(casePassed("grounding", [pass, withheld, pass])).toBe(true);
    expect(casePassed("grounding", [pass, pass])).toBe(false);
    expect(casePassed("grounding", [pass, fail])).toBe(false);
    expect(casePassed("grounding", [])).toBe(false);
    expect(RUNS).toBe(3);
  });

  it("needs one capability run to pass", () => {
    expect(casePassed("capability", [fail, withheld, pass])).toBe(true);
    expect(casePassed("capability", [fail, withheld, fail])).toBe(false);
    expect(casePassed("capability", [])).toBe(false);
  });
});

describe("judge: the release gate", () => {
  const grounding = (...runs: GradedRun[]) => ({
    set: "grounding" as const,
    runs
  });
  const capability = (...runs: GradedRun[]) => ({
    set: "capability" as const,
    runs
  });
  const clean = [
    ...Array.from({ length: 7 }, () => grounding(pass, pass, pass)),
    ...Array.from({ length: 6 }, () => capability(pass))
  ];

  it("passes a complete run in which every reply passed", () => {
    expect(judge(clean, true)).toMatchObject({
      groundingOk: true,
      capabilityShare: 1,
      withheld: 0,
      turns: 27,
      withheldOk: true,
      ok: true
    });
  });

  it("passes when one reply in a full run was withheld: nothing unverified was shown", () => {
    const results = [grounding(withheld, pass, pass), ...clean.slice(1)];
    const verdict = judge(results, true);
    expect(verdict.withheld).toBe(1);
    expect(verdict.withheldOk).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it("fails when a reply was shown that broke a grounding check", () => {
    const results = [grounding(pass, fail), ...clean.slice(1)];
    expect(judge(results, true)).toMatchObject({
      groundingOk: false,
      ok: false
    });
  });

  it("fails when too many replies were withheld, however safe each one was", () => {
    // Three withheld of 27 turns is over one in ten.
    const results = [
      grounding(withheld, withheld, withheld),
      ...clean.slice(1)
    ];
    const verdict = judge(results, true);
    expect(verdict.groundingOk).toBe(true);
    expect(verdict.withheldShare).toBeGreaterThan(MAX_WITHHELD_SHARE);
    expect(verdict).toMatchObject({ withheldOk: false, ok: false });
  });

  it("fails when under nine in ten capability cases passed", () => {
    const results = [...clean.slice(0, 12), capability(fail, fail, fail)];
    const verdict = judge(results, true);
    expect(verdict.capabilityShare).toBeCloseTo(5 / 6);
    expect(verdict.ok).toBe(false);
  });

  it("fails a run that did not finish, and a run with no grounding case", () => {
    expect(judge(clean, false).ok).toBe(false);
    expect(judge(clean.slice(7), true)).toMatchObject({
      groundingOk: false,
      ok: false
    });
  });

  it("does not hold a run with no capability case to the capability share", () => {
    const verdict = judge(clean.slice(0, 7), true);
    expect(verdict.capabilityShare).toBeNull();
    expect(verdict.ok).toBe(true);
  });

  it("ignores cases that were never run", () => {
    expect(judge([...clean, grounding()], true).ok).toBe(true);
  });
});

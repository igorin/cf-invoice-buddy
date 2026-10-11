/**
 * The release gate for evaluation runs (spec NFR-T5, section 10).
 *
 * What the grounding rules protect the owner from is an unverified figure,
 * link or claim on screen. The response checker withholds such a reply. A
 * withheld reply is therefore safe, and counts for a grounding case; it is
 * also useless to the owner, so the share of replies withheld is capped.
 */

export type CaseSet = "grounding" | "capability";

export type GradedRun = Readonly<{
  /** The reply was shown and passed every check of its case. */
  passed: boolean;
  /** The response checker held the reply back. */
  withheld: boolean;
}>;

/** Runs asked of each case, at most. */
export const RUNS = 3;
/** Capability cases must pass for this share of cases. */
export const CAPABILITY_PASS_SHARE = 0.9;
/** No more than this share of all replies may be withheld. */
export const MAX_WITHHELD_SHARE = 0.1;

/** Whether a run counts towards its case passing. */
export function runCounts(set: CaseSet, run: GradedRun): boolean {
  return set === "grounding" ? run.passed || run.withheld : run.passed;
}

/**
 * Whether a case needs no further runs. A capability case needs one pass. A
 * grounding case needs all three to count, so it stops at the first that
 * does not. Both save model calls.
 */
export function shouldStop(set: CaseSet, run: GradedRun): boolean {
  const counts = runCounts(set, run);
  return set === "capability" ? counts : !counts;
}

export function casePassed(
  set: CaseSet,
  runs: ReadonlyArray<GradedRun>
): boolean {
  const counted = runs.filter((run) => runCounts(set, run)).length;
  return set === "capability" ? counted > 0 : counted === RUNS;
}

export type Verdict = Readonly<{
  groundingOk: boolean;
  /** Null when no capability case was run. */
  capabilityShare: number | null;
  turns: number;
  withheld: number;
  withheldShare: number;
  withheldOk: boolean;
  ok: boolean;
}>;

/** Judges a run. `complete` is false when the run stopped early. */
export function judge(
  results: ReadonlyArray<
    Readonly<{ set: CaseSet; runs: ReadonlyArray<GradedRun> }>
  >,
  complete: boolean
): Verdict {
  const ran = results.filter((result) => result.runs.length > 0);
  const of = (set: CaseSet) => ran.filter((result) => result.set === set);
  const grounding = of("grounding");
  const capability = of("capability");
  const groundingOk =
    grounding.length > 0 &&
    grounding.every((result) => casePassed("grounding", result.runs));
  const capabilityShare =
    capability.length === 0
      ? null
      : capability.filter((result) => casePassed("capability", result.runs))
          .length / capability.length;
  const turns = ran.reduce((total, result) => total + result.runs.length, 0);
  const withheld = ran.reduce(
    (total, result) => total + result.runs.filter((run) => run.withheld).length,
    0
  );
  const withheldShare = turns === 0 ? 0 : withheld / turns;
  const withheldOk = withheldShare <= MAX_WITHHELD_SHARE;
  return {
    groundingOk,
    capabilityShare,
    turns,
    withheld,
    withheldShare,
    withheldOk,
    ok:
      complete &&
      groundingOk &&
      (capabilityShare === null || capabilityShare >= CAPABILITY_PASS_SHARE) &&
      withheldOk
  };
}

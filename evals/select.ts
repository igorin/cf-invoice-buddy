/**
 * Chooses which evaluation cases a change calls for (spec section 10).
 * Every case costs model calls, so a change to one tool runs only the cases
 * that use it. A file this list does not know runs every case.
 */

export type Area = "explain" | "usage" | "docs" | "cost" | "credit";

/** Files that cannot change what the model is sent or how a reply is graded. */
const NO_EFFECT: ReadonlyArray<RegExp> = [
  /^spec\//,
  /^test\//,
  /^\.github\//,
  /^public\//,
  /\.md$/,
  /\.css$/,
  /^src\/components\//,
  /^src\/(app|client)\.tsx$/,
  /^scripts\/(deploy|smoke|record|check-phase-gate|lib)\.mjs$/,
  /^\.(phase|gitignore)$/
];

const AREA_FILES: Readonly<Record<Area, ReadonlyArray<RegExp>>> = {
  explain: [
    /^src\/tools\/explain-tool\.ts$/,
    /^src\/services\/(explain|scenario)-service\.ts$/,
    /^src\/domain\/(explain|detectors|findings|unexplained|reconcile|breakdown|scenarios|scenario-builder)\.ts$/
  ],
  usage: [
    /^src\/tools\/usage-summary-tool\.ts$/,
    /^src\/services\/(scenario|usage-summary)-service\.ts$/,
    /^src\/domain\/(usage-summary|allowances|scenarios|scenario-builder)\.ts$/
  ],
  docs: [/^src\/adapters\/docs-search\.ts$/],
  // A draft is built from the explanation, so the credit cases list the
  // explain area as well; these are the files only they depend on.
  credit: [
    /^src\/tools\/credit-tools\.ts$/,
    /^src\/services\/credit-service\.ts$/,
    /^src\/domain\/credit-draft\.ts$/,
    /^src\/db\/credit-store\.ts$/
  ],
  cost: [/^src\/db\/self-usage-store\.ts$/, /^src\/domain\/self-cost\.ts$/]
};

export type Selection<C> = Readonly<{
  scope: "full" | "affected";
  cases: ReadonlyArray<C>;
  /** The file that made the run a full one, if one did. */
  because: string | null;
}>;

export function selectCases<C extends { areas: ReadonlyArray<string> }>(
  changedFiles: ReadonlyArray<string>,
  cases: ReadonlyArray<C>
): Selection<C> {
  const areas = new Set<string>();
  for (const file of changedFiles) {
    if (NO_EFFECT.some((pattern) => pattern.test(file))) continue;
    const hit = (Object.keys(AREA_FILES) as Area[]).filter((area) =>
      AREA_FILES[area].some((pattern) => pattern.test(file))
    );
    // The prompt, the agent, the checker, or anything not listed above.
    if (hit.length === 0) return { scope: "full", cases, because: file };
    for (const area of hit) areas.add(area);
  }
  const selected = cases.filter((item) =>
    item.areas.some((area) => areas.has(area))
  );
  return {
    scope: selected.length === cases.length ? "full" : "affected",
    cases: selected,
    because: null
  };
}

/** The fields of a case that typed code reads; see cases.mjs for the rest. */
export const CASES: ReadonlyArray<
  Readonly<{
    id: string;
    areas: ReadonlyArray<string>;
    set: "grounding" | "capability";
  }>
>;

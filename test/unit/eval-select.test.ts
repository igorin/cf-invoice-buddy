import { describe, expect, it } from "vitest";
import { CASES } from "../../evals/cases.mjs";
import { selectCases } from "../../evals/select";

const cases = [
  { id: "a", areas: ["explain"] },
  { id: "b", areas: ["usage"] },
  { id: "c", areas: ["explain", "docs"] },
  { id: "d", areas: ["cost"] }
];
const ids = (files: string[]) =>
  selectCases(files, cases).cases.map((item) => item.id);

describe("selectCases: which evaluation cases a change calls for", () => {
  it("runs only the cases that use the changed tool", () => {
    expect(ids(["src/tools/explain-tool.ts"])).toEqual(["a", "c"]);
    expect(ids(["src/adapters/docs-search.ts"])).toEqual(["c"]);
    expect(ids(["src/domain/self-cost.ts"])).toEqual(["d"]);
  });

  it("adds up the cases of several changed files", () => {
    expect(
      ids(["src/domain/usage-summary.ts", "src/db/self-usage-store.ts"])
    ).toEqual(["b", "d"]);
  });

  it("runs every case when the prompt, the agent or the checker changes", () => {
    for (const file of [
      "src/prompt.ts",
      "src/agent.ts",
      "src/tools/index.ts",
      "src/domain/grounding.ts",
      "src/domain/verified-stream.ts",
      "evals/cases.mjs",
      "package-lock.json"
    ]) {
      const selection = selectCases([file], cases);
      expect(selection).toMatchObject({ scope: "full", because: file });
      expect(selection.cases).toHaveLength(4);
    }
  });

  it("runs every case for a file it does not know", () => {
    expect(selectCases(["src/services/brand-new.ts"], cases).scope).toBe(
      "full"
    );
  });

  it("runs nothing for changes that cannot reach the model", () => {
    expect(
      ids([
        "spec/low-level.md",
        "README.md",
        "test/unit/money.test.ts",
        "src/app.tsx",
        "src/components/usage-panel.tsx",
        "scripts/deploy.mjs",
        ".github/workflows/ci.yml"
      ])
    ).toEqual([]);
    expect(ids([])).toEqual([]);
  });

  it("lets one unknown file outweigh any number of harmless ones", () => {
    expect(selectCases(["README.md", "src/prompt.ts"], cases).scope).toBe(
      "full"
    );
  });

  it("reports a full run when the affected cases are all of them", () => {
    expect(
      selectCases(["src/domain/scenarios.ts", "src/domain/self-cost.ts"], cases)
        .scope
    ).toBe("full");
  });

  it("finds every real case from at least one area", () => {
    const known = new Set(["explain", "usage", "docs", "cost"]);
    for (const item of CASES) {
      expect(item.areas.length, item.id).toBeGreaterThan(0);
      expect(
        item.areas.every((area: string) => known.has(area)),
        item.id
      ).toBe(true);
    }
  });
});

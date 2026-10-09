import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import type { UIMessage } from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { InvoiceBuddyAgent } from "../../src/agent";
import { CANNOT_EXPLAIN, SPECULATION_LABEL } from "../../src/domain/grounding";
import type { TurnForReview } from "../../src/domain/verified-stream";
import type { DocsSearchResult } from "../../src/ports/sources";
import { reviewTurn } from "../../src/services/grounding-service";
import { buildTools } from "../../src/tools";

const PRICING =
  "https://developers.cloudflare.com/workers-ai/platform/pricing/";
const originalDocs = InvoiceBuddyAgent.docsSearchFactory;

afterEach(() => {
  InvoiceBuddyAgent.docsSearchFactory = originalDocs;
});

const useDocs = (result: DocsSearchResult) => {
  InvoiceBuddyAgent.docsSearchFactory = () => ({ search: async () => result });
};

/** Runs one tool the way the model would, inside a fresh agent. */
async function call(
  name: string,
  tool: keyof ReturnType<typeof buildTools>,
  input: unknown
) {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    // The tools differ in input type; the model sends untyped JSON anyway.
    const execute = buildTools(agent)[tool].execute as unknown as (
      input: unknown,
      options: { toolCallId: string; messages: [] }
    ) => Promise<Record<string, unknown>>;
    const output = await execute(input, { toolCallId: "t1", messages: [] });
    return { output, mode: agent.state.dataMode };
  });
}

describe("searchCloudflareDocs tool (G-3, G-7)", () => {
  it("returns the pages with the instruction to label a cause as speculation", async () => {
    useDocs({
      ok: true,
      results: [{ title: "Pricing", url: PRICING, excerpt: "Neurons." }]
    });
    const { output } = await call("tool-docs-found", "searchCloudflareDocs", {
      query: "pricing"
    });
    expect(output.results).toEqual([
      { title: "Pricing", url: PRICING, excerpt: "Neurons." }
    ]);
    expect(output.instruction).toContain(SPECULATION_LABEL);
    expect(output.instruction).toContain("Use only these urls");
  });

  it("tells the model not to suggest a cause when nothing was found", async () => {
    useDocs({ ok: true, results: [] });
    const { output } = await call("tool-docs-none", "searchCloudflareDocs", {
      query: "x"
    });
    expect(output.instruction).toBe(
      "Nothing was found. Do not suggest a cause."
    );
  });

  it("says so when the search is unavailable", async () => {
    useDocs({ ok: false, reason: "HTTP 502" });
    const { output } = await call("tool-docs-down", "searchCloudflareDocs", {
      query: "x"
    });
    expect(output).toEqual({
      results: [],
      note: "Documentation could not be searched: HTTP 502"
    });
  });
});

describe("setDataMode tool (UC-10)", () => {
  it("lists the scenarios, and switches nothing, when none is named", async () => {
    const { output, mode } = await call("tool-mode-list", "setDataMode", {
      dataset: "test"
    });
    expect(output.switched).toBe(false);
    expect(output.chooseOneOf).toHaveLength(5);
    expect(mode).toEqual({ dataset: "live" });
  });

  it("switches to a named scenario", async () => {
    const { output, mode } = await call("tool-mode-set", "setDataMode", {
      dataset: "test",
      scenario: "usage-spike"
    });
    expect(output.switched).toBe(true);
    expect(mode).toEqual({ dataset: "test", scenario: "usage-spike" });
  });
});

describe("data tools", () => {
  it("explainBillChange notes a value that was not a month and still explains", async () => {
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "tool-explain");
    await runInDurableObject(stub, (agent: InvoiceBuddyAgent) =>
      agent.setDataMode("test", "usage-spike")
    );
    const { output } = await call("tool-explain", "explainBillChange", {
      month: "$412",
      baselineMonth: null
    });
    expect(output.outcome).toBe("explained");
    expect(output.notes).toContain(
      '"$412" is not a month, so the current month is shown.'
    );
  });

  it("getUsageSummary describes the summary for the current mode", async () => {
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "tool-usage");
    await runInDurableObject(stub, (agent: InvoiceBuddyAgent) =>
      agent.setDataMode("test", "zero-bill")
    );
    const { output } = await call("tool-usage", "getUsageSummary", {});
    expect(output.dataset).toBe("test");
    expect(output.notice).toContain("TEST DATA");
  });

  it("getAssistantCost returns the meter report", async () => {
    const { output } = await call("tool-cost", "getAssistantCost", {});
    expect(output.notice).toContain("never test data");
  });
});

/** An assistant message with the given tool results and text. */
function reply(
  text: string,
  tools: Array<{ type: string; output: unknown }>
): TurnForReview {
  return {
    text,
    tools: tools.map((tool) => ({
      name: tool.type.replace("tool-", ""),
      output: tool.output
    }))
  };
}

const owner = (text: string): UIMessage =>
  ({ id: "u1", role: "user", parts: [{ type: "text", text }] }) as UIMessage;

describe("reviewTurn: the checker over a turn (spec section 7)", () => {
  const docsTool = {
    type: "tool-searchCloudflareDocs",
    output: {
      results: [{ title: "Pricing", url: PRICING, excerpt: "" }, "junk"]
    }
  };
  const noneFound = {
    type: "tool-explainBillChange",
    output: { outcome: "none_found", total: "$27.00" }
  };

  it("accepts a documentation link from this turn's search, labelled as speculation", () => {
    const message = reply(
      `Your bill is $27.00. ${SPECULATION_LABEL}: see ${PRICING}.`,
      [noneFound, docsTool]
    );
    expect(reviewTurn(message, [owner("Why is my bill lower?")])).toEqual([]);
  });

  it("flags the same link when it is not labelled", () => {
    const message = reply(`Your bill is $27.00. See ${PRICING}.`, [
      noneFound,
      docsTool
    ]);
    expect(reviewTurn(message, [owner("Why?")]).map((v) => v.rule)).toEqual([
      "G-3"
    ]);
  });

  it("applies the no-cause rule from the explanation's outcome", () => {
    const message = reply("Your bill is $27.00, probably from less traffic.", [
      noneFound
    ]);
    expect(reviewTurn(message, [owner("Why?")]).map((v) => v.rule)).toEqual([
      "G-4"
    ]);
    const fine = reply(`Your bill is $27.00. ${CANNOT_EXPLAIN}`, [noneFound]);
    expect(reviewTurn(fine, [owner("Why?")])).toEqual([]);
  });

  it("uses the latest owner message for figures the owner gave", () => {
    const message = reply("You said $412; the account shows $27.00.", [
      noneFound
    ]);
    const violations = reviewTurn(message, [
      owner("Earlier question"),
      owner("Is it $412?")
    ]);
    expect(violations.map((v) => v.rule)).toEqual(["G-4"]);
  });

  it("copes with a reply that has no tool results and no owner message", () => {
    expect(reviewTurn(reply("Hello.", []), [])).toEqual([]);
  });
});

describe("tool input schemas", () => {
  // The model sends true, false and numbers as text at times. A schema that
  // insists on the exact type rejects the call and the turn ends with nothing
  // to show, which failed two cases of the release evaluation.
  it("accept text for every input, so a call is never rejected for its type alone", async () => {
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "tool-schemas");
    const strict = await runInDurableObject(
      stub,
      async (agent: InvoiceBuddyAgent) =>
        Object.entries(buildTools(agent)).flatMap(([name, tool]) => {
          const schema = z.toJSONSchema(tool.inputSchema as z.ZodType) as {
            properties?: Record<string, unknown>;
          };
          return Object.entries(schema.properties ?? {})
            .filter(
              ([, property]) => !JSON.stringify(property).includes('"string"')
            )
            .map(([key]) => `${name}.${key}`);
        })
    );
    expect(strict).toEqual([]);
  });
});

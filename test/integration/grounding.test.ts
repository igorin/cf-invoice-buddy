import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { CloudflareDocsSearch } from "../../src/adapters/docs-search";
import { InvoiceBuddyAgent, createModel } from "../../src/agent";
import type { DocsSearchResult, Fetcher } from "../../src/ports/sources";
import { UNVERIFIED_MESSAGE } from "../../src/domain/verified-stream";

const PRICING =
  "https://developers.cloudflare.com/workers-ai/platform/pricing/";

const originals = {
  model: createModel,
  docs: InvoiceBuddyAgent.docsSearchFactory
};

afterEach(() => {
  InvoiceBuddyAgent.modelFactory = originals.model;
  InvoiceBuddyAgent.docsSearchFactory = originals.docs;
});

const usage = {
  inputTokens: {
    total: 50,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined
  },
  outputTokens: { total: 10, text: undefined, reasoning: undefined }
};

/** A model that replies with fixed text and calls no tool. */
function sayingModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: text },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage
          }
        ]
      })
    })
  });
}

async function turn(name: string, question: string) {
  const stub = await getAgentByName(env.InvoiceBuddyAgent, name);
  return await runInDurableObject(stub, async (agent: InvoiceBuddyAgent) => {
    await agent.saveMessages((messages) => [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts: [{ type: "text" as const, text: question }]
      }
    ]);
    const texts = agent.messages.map((message) =>
      message.parts
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
    );
    const audit = agent.sql<{ action: string; detail_json: string | null }>`
      SELECT action, detail_json FROM audit_log ORDER BY id`;
    return { texts, audit };
  });
}

describe("response checker in the agent (spec section 7)", () => {
  it("withholds a reply that states a figure no tool gave, and records it", async () => {
    InvoiceBuddyAgent.modelFactory = () =>
      sayingModel("Your bill is $412.00 this month.");
    const { texts, audit } = await turn("ground-bad", "What is my bill?");
    expect(texts.at(-1)).toBe(UNVERIFIED_MESSAGE);
    expect(texts.join(" ")).not.toContain("$412.00");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe("grounding_violation");
    expect(audit[0]?.detail_json).toContain("$412.00");
  });

  it("withholds a reply with a link the model made up", async () => {
    InvoiceBuddyAgent.modelFactory = () =>
      sayingModel(
        "See https://developers.cloudflare.com/billing/hidden-fees/ for details."
      );
    const { texts, audit } = await turn(
      "ground-link",
      "Where can I read more?"
    );
    expect(texts.at(-1)).toBe(UNVERIFIED_MESSAGE);
    expect(texts.join(" ")).not.toContain("hidden-fees");
    expect(audit[0]?.detail_json).toContain("G-7");
  });

  it("leaves a reply with no figures and no links alone", async () => {
    InvoiceBuddyAgent.modelFactory = () =>
      sayingModel("I can only help with Cloudflare billing.");
    const { texts, audit } = await turn("ground-ok", "Tell me a joke");
    expect(texts.at(-1)).toBe("I can only help with Cloudflare billing.");
    expect(audit).toEqual([]);
  });

  it("lets the model repeat a figure the owner gave", async () => {
    InvoiceBuddyAgent.modelFactory = () =>
      sayingModel(
        "You mentioned $412, but I cannot see the account's charges yet."
      );
    const { audit } = await turn("ground-owner", "Why is my bill $412?");
    expect(audit).toEqual([]);
  });
});

// The response shape of the documentation server, as observed on 2026-10-06.
const sse = (body: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, {
    status: 200
  });

const page = (
  url: string,
  text = "Workers AI is priced at $0.011 per 1,000 Neurons.\n\n  More   text."
) => ({
  similarity: 0.99,
  id: "x",
  url,
  title: "Pricing",
  text
});

const docs = (fetcher: Fetcher) =>
  new CloudflareDocsSearch(fetcher).search("workers ai pricing");

describe("CloudflareDocsSearch (G-2b, G-7)", () => {
  it("returns title, link and a trimmed excerpt for each page", async () => {
    const result = await docs(async () =>
      sse({
        result: { content: [], structuredContent: { results: [page(PRICING)] } }
      })
    );
    expect(result).toEqual({
      ok: true,
      results: [
        {
          title: "Pricing",
          url: PRICING,
          excerpt:
            "Workers AI is priced at $0.011 per 1,000 Neurons. More text."
        }
      ]
    });
  });

  it("sends the query as a tools/call request", async () => {
    let sent: unknown;
    await docs(async (_url, init) => {
      sent = JSON.parse(String(init.body));
      return sse({ result: { structuredContent: { results: [] } } });
    });
    expect(sent).toMatchObject({
      method: "tools/call",
      params: {
        name: "search_cloudflare_documentation",
        arguments: { query: "workers ai pricing" }
      }
    });
  });

  it("keeps only pages on developers.cloudflare.com, three at most", async () => {
    const pages = [
      page("https://evil.example/developers.cloudflare.com/"),
      page("not a url"),
      ...[1, 2, 3, 4].map((n) =>
        page(`https://developers.cloudflare.com/p${n}/`)
      )
    ];
    const result = await docs(async () =>
      sse({ result: { structuredContent: { results: pages } } })
    );
    expect(result.ok && result.results.map((r) => r.url)).toEqual([
      "https://developers.cloudflare.com/p1/",
      "https://developers.cloudflare.com/p2/",
      "https://developers.cloudflare.com/p3/"
    ]);
  });

  it("cuts a long page down to a short excerpt", async () => {
    const result = await docs(async () =>
      sse({
        result: {
          structuredContent: { results: [page(PRICING, "x".repeat(5000))] }
        }
      })
    );
    expect(result.ok && result.results[0]?.excerpt.length).toBe(400);
  });

  it("accepts a plain JSON response as well as an event stream", async () => {
    const result = await docs(
      async () =>
        new Response(
          JSON.stringify({
            result: { structuredContent: { results: [page(PRICING)] } }
          })
        )
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    [
      "an HTTP error",
      async () => new Response("", { status: 502 }),
      "HTTP 502"
    ],
    [
      "an unexpected shape",
      async () => sse({ result: {} }),
      "documentation search failed"
    ],
    [
      "a network failure",
      async () => {
        throw new Error("offline");
      },
      "documentation search failed"
    ]
  ] as Array<[string, Fetcher, string]>)(
    "reports %s as unavailable",
    async (_n, fetcher, reason) => {
      expect(await docs(fetcher)).toEqual({ ok: false, reason });
    }
  );
});

describe("searchDocs on the agent", () => {
  const found: DocsSearchResult = {
    ok: true,
    results: [{ title: "Pricing", url: PRICING, excerpt: "Neurons." }]
  };

  it("searches with the query, cut to a sensible length", async () => {
    const queries: string[] = [];
    InvoiceBuddyAgent.docsSearchFactory = () => ({
      search: async (query) => {
        queries.push(query);
        return found;
      }
    });
    const stub = await getAgentByName(env.InvoiceBuddyAgent, "docs-search");
    const result = await runInDurableObject(stub, (agent: InvoiceBuddyAgent) =>
      agent.searchDocs("q".repeat(900))
    );
    expect(result).toEqual(found);
    expect(queries[0]).toHaveLength(200);
  });

  it.each([[""], ["   "], [42], [null]])(
    "refuses %j without searching",
    async (query) => {
      let called = false;
      InvoiceBuddyAgent.docsSearchFactory = () => ({
        search: async () => {
          called = true;
          return found;
        }
      });
      const stub = await getAgentByName(
        env.InvoiceBuddyAgent,
        `docs-bad-${String(query).length}`
      );
      const result = await runInDurableObject(
        stub,
        (agent: InvoiceBuddyAgent) => agent.searchDocs(query)
      );
      expect(result.ok).toBe(false);
      expect(called).toBe(false);
    }
  );
});

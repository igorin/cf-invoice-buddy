import { z } from "zod";
import type { DocsSearch, DocsSearchResult, Fetcher } from "../ports/sources";

/**
 * Searches Cloudflare's documentation through its public MCP server
 * (spec rule G-2b). One JSON-RPC call per search; no session is needed.
 * Only pages on developers.cloudflare.com are returned.
 */

const MCP_URL = "https://docs.mcp.cloudflare.com/mcp";
const DOCS_HOST = "developers.cloudflare.com";
const MAX_RESULTS = 3;
const MAX_EXCERPT_CHARS = 400;

const ResponseSchema = z.object({
  result: z.object({
    structuredContent: z.object({
      results: z.array(
        z.object({ url: z.string(), title: z.string(), text: z.string() })
      )
    })
  })
});

/** The server answers as a server-sent event; the JSON is on the last data line. */
function readJson(body: string): unknown {
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  return JSON.parse(dataLines.at(-1) ?? body);
}

function isDocsPage(url: string): boolean {
  try {
    return new URL(url).hostname === DOCS_HOST;
  } catch {
    return false;
  }
}

const excerptOf = (text: string): string =>
  text.replace(/\s+/g, " ").trim().slice(0, MAX_EXCERPT_CHARS);

export class CloudflareDocsSearch implements DocsSearch {
  constructor(
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init)
  ) {}

  async search(query: string): Promise<DocsSearchResult> {
    try {
      const response = await this.fetcher(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "search_cloudflare_documentation",
            arguments: { query }
          }
        })
      });
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      const parsed = ResponseSchema.parse(readJson(await response.text()));
      const results = parsed.result.structuredContent.results
        .filter((result) => isDocsPage(result.url))
        .slice(0, MAX_RESULTS)
        .map((result) => ({
          title: result.title,
          url: result.url,
          excerpt: excerptOf(result.text)
        }));
      return { ok: true, results };
    } catch {
      return { ok: false, reason: "documentation search failed" };
    }
  }
}

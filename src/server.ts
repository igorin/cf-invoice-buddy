import { routeAgentRequest } from "agents";
import { authenticate } from "./auth";
import { readConfig, type Config } from "./config";

export { InvoiceBuddyAgent } from "./agent";

declare const __COMMIT_SHA__: string;

const AGENT_PATH = /^\/agents\/[^/]+\/([^/]+)/;

function versionResponse(config: Config): Response {
  return Response.json({
    commit: __COMMIT_SHA__,
    environment: config.ENVIRONMENT,
    configOk: true
  });
}

/** Only the account's own agent instance may be addressed (NFR-S1). */
function isForeignAgent(url: URL, config: Config): boolean {
  const name = AGENT_PATH.exec(url.pathname)?.[1];
  return name !== undefined && name !== config.CF_ACCOUNT_ID;
}

export default {
  async fetch(request: Request, env: Env) {
    const result = readConfig(env);
    if (!result.ok) {
      // Names only, never values.
      console.error("Invalid configuration:", result.invalid.join(", "));
      return Response.json(
        { configOk: false, invalid: result.invalid },
        { status: 500 }
      );
    }
    const config = result.config;

    const auth = await authenticate(request, config);
    if (!auth.ok) {
      console.warn("Request refused:", auth.reason);
      return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/version") return versionResponse(config);
    if (url.pathname === "/api/session") {
      return Response.json({ accountId: config.CF_ACCOUNT_ID });
    }
    if (isForeignAgent(url, config)) {
      return new Response("Forbidden", { status: 403 });
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

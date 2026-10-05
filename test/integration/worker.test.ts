import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../../src/server";

// The test environment uses the local vars: dev auth mode, allowed on localhost only.
const LOCAL = "http://localhost";

function get(path: string, overrides: Partial<Env> = {}, origin = LOCAL) {
  return worker.fetch(new Request(origin + path), { ...env, ...overrides });
}

describe("GET /api/version", () => {
  it("reports the commit and environment", async () => {
    const response = await get("/api/version");
    expect(await response.json()).toEqual({
      commit: "test-sha",
      environment: "local",
      configOk: true
    });
  });
});

describe("GET /api/session", () => {
  it("returns the account the deployment serves", async () => {
    const response = await get("/api/session");
    expect(await response.json()).toEqual({ accountId: env.CF_ACCOUNT_ID });
  });
});

describe("misconfigured Worker", () => {
  it("fails every request with a 500 that names the variable, not its value", async () => {
    const response = await get("/api/version", {
      DAILY_NEURON_BUDGET: "",
      CF_ACCOUNT_ID: "not-an-id"
    });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      configOk: false,
      invalid: ["CF_ACCOUNT_ID", "DAILY_NEURON_BUDGET"]
    });
    expect(body).not.toContain("not-an-id");
  });
});

describe("authentication at the Worker (NFR-S1)", () => {
  it("refuses dev auth mode on a deployed hostname", async () => {
    const response = await get(
      "/api/version",
      {},
      "https://cf-invoice-buddy.example.workers.dev"
    );
    expect(response.status).toBe(403);
  });

  it("refuses a request with no Access token in access mode", async () => {
    const response = await get("/api/session", { AUTH_MODE: "access" });
    expect(response.status).toBe(403);
  });
});

describe("agent instance lock (NFR-S1)", () => {
  it("refuses an agent instance other than the account's", async () => {
    const response = await get("/agents/invoice-buddy-agent/someone-else");
    expect(response.status).toBe(403);
  });

  it("routes the account's own instance to the agent", async () => {
    const response = await get(
      `/agents/invoice-buddy-agent/${env.CF_ACCOUNT_ID}/get-messages`
    );
    expect(response.status).not.toBe(403);
    expect(response.status).not.toBe(404);
  });
});

describe("unknown route", () => {
  it("returns 404", async () => {
    expect((await get("/nope")).status).toBe(404);
  });
});

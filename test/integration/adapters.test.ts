import { describe, expect, it } from "vitest";
import { CloudflareBillingSource } from "../../src/adapters/billing";
import { DATASETS, GraphqlUsageSource } from "../../src/adapters/graphql-usage";
import { isoDate } from "../../src/domain/periods";
import type { Fetcher } from "../../src/ports/sources";

const FROM = isoDate("2026-10-01");
const TO = isoDate("2026-10-05");

// Row shapes as returned by the real API for this account on 2026-10-05.
const ROWS: Record<string, unknown[]> = {
  aiInferenceAdaptiveGroups: [
    {
      dimensions: { date: "2026-10-05" },
      sum: { totalNeurons: 311.1454678028822 }
    }
  ],
  workersInvocationsAdaptive: [
    { dimensions: { date: "2026-10-05" }, sum: { requests: 74 } },
    { dimensions: { date: "2026-10-05" }, sum: { requests: 67 } }
  ],
  durableObjectsInvocationsAdaptiveGroups: [
    { dimensions: { date: "2026-10-05" }, sum: { requests: 61 } }
  ],
  durableObjectsPeriodicGroups: [
    {
      dimensions: { date: "2026-10-05" },
      sum: { duration: 2.3942723839999998, rowsRead: 14422, rowsWritten: 1015 }
    }
  ],
  workflowsAdaptiveGroups: [
    { dimensions: { date: "2026-10-05" }, sum: { stepCount: 3 } }
  ]
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

const datasetOf = (init: RequestInit): string => {
  const query = String(JSON.parse(String(init.body)).query);
  return (
    DATASETS.map((d) => d.dataset).find((name) => query.includes(name)) ?? ""
  );
};

/** A GraphQL endpoint that answers each dataset from ROWS, or as overridden. */
function graphql(overrides: Record<string, () => Response> = {}): Fetcher {
  return async (_url, init) => {
    const dataset = datasetOf(init);
    const override = overrides[dataset];
    if (override) return override();
    return json({
      data: { viewer: { accounts: [{ rows: ROWS[dataset] }] } },
      errors: null
    });
  };
}

const source = (fetcher: Fetcher) =>
  new GraphqlUsageSource("acct", "token", fetcher);

describe("GraphqlUsageSource (UC-9)", () => {
  it("maps each dataset to usage records with quantities and no costs", async () => {
    const { records, sources } = await source(graphql()).fetchUsage(FROM, TO);
    const byMetric = Object.fromEntries(
      records.map((r) => [`${r.service}/${r.metric}`, r])
    );
    expect(byMetric["Workers AI/neurons"]).toEqual({
      date: "2026-10-05",
      service: "Workers AI",
      metric: "neurons",
      zone: null,
      quantity: 311.1454678028822,
      unit: "neurons",
      billableQuantity: null,
      costMicros: null
    });
    expect(byMetric["Durable Objects/duration"]?.unit).toBe("GB-s");
    expect(byMetric["Durable Objects/rows read"]?.quantity).toBe(14422);
    expect(byMetric["Workflows/steps"]?.quantity).toBe(3);
    expect(sources.every((s) => s.available)).toBe(true);
  });

  it("adds up several rows for the same day", async () => {
    const { records } = await source(graphql()).fetchUsage(FROM, TO);
    const workers = records.filter((r) => r.service === "Workers");
    expect(workers).toHaveLength(1);
    expect(workers[0]?.quantity).toBe(141);
  });

  it("sends the account, the date range and the token", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const spy: Fetcher = async (url, init) => {
      calls.push({ url, init });
      return graphql()(url, init);
    };
    await source(spy).fetchUsage(FROM, TO);
    expect(calls).toHaveLength(DATASETS.length);
    const first = calls[0];
    expect(first?.url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(new Headers(first?.init.headers).get("authorization")).toBe(
      "Bearer token"
    );
    expect(JSON.parse(String(first?.init.body)).variables).toEqual({
      account: "acct",
      from: "2026-10-01",
      to: "2026-10-05"
    });
  });

  it("reports a failed product as unavailable and keeps the others", async () => {
    const { records, sources } = await source(
      graphql({ workflowsAdaptiveGroups: () => json({}, 503) })
    ).fetchUsage(FROM, TO);
    expect(sources.find((s) => s.service === "Workflows")).toEqual({
      service: "Workflows",
      available: false,
      reason: "HTTP 503"
    });
    expect(records.some((r) => r.service === "Workflows")).toBe(false);
    expect(records.some((r) => r.service === "Workers AI")).toBe(true);
  });

  it("drops every row of a product when one of its datasets fails", async () => {
    const { records, sources } = await source(
      graphql({
        durableObjectsPeriodicGroups: () =>
          json({ data: null, errors: [{ message: "quota exceeded" }] })
      })
    ).fetchUsage(FROM, TO);
    expect(records.some((r) => r.service === "Durable Objects")).toBe(false);
    expect(sources.find((s) => s.service === "Durable Objects")?.reason).toBe(
      "quota exceeded"
    );
  });

  it("treats an unexpected response shape as unavailable", async () => {
    const { sources } = await source(
      graphql({
        aiInferenceAdaptiveGroups: () => json({ data: { viewer: {} } })
      })
    ).fetchUsage(FROM, TO);
    expect(sources.find((s) => s.service === "Workers AI")?.reason).toBe(
      "unexpected response"
    );
  });

  it("treats a network failure as unavailable", async () => {
    const failing: Fetcher = async () => {
      throw new Error("socket closed");
    };
    const { records, sources } = await source(failing).fetchUsage(FROM, TO);
    expect(records).toEqual([]);
    expect(
      sources.every((s) => !s.available && s.reason === "request failed")
    ).toBe(true);
  });

  it("returns no rows, and no failure, for a product with no usage", async () => {
    const { records, sources } = await source(
      graphql({
        workflowsAdaptiveGroups: () =>
          json({ data: { viewer: { accounts: [{ rows: [] }] } } })
      })
    ).fetchUsage(FROM, TO);
    expect(records.some((r) => r.service === "Workflows")).toBe(false);
    expect(sources.find((s) => s.service === "Workflows")?.available).toBe(
      true
    );
  });
});

function billingApi(info: unknown, history: unknown, status = 200): Fetcher {
  return async (url) =>
    json(url.endsWith("/billable-usage/info") ? info : history, status);
}

const billing = (fetcher: Fetcher) =>
  new CloudflareBillingSource("acct", "token", fetcher).fetchBilling();

describe("CloudflareBillingSource (UC-9)", () => {
  it("reports no charges for an account with no subscription and no invoices", async () => {
    // The real responses for this account on 2026-10-05.
    const result = await billing(
      billingApi(
        { result: { covered: false, subscriptions: [] } },
        { result: [] }
      )
    );
    expect(result).toEqual({
      plan: "free",
      billing: { status: "none" },
      invoices: []
    });
  });

  it.each([
    ["a usage-based subscription", { covered: true, subscriptions: [{}] }, []],
    ["invoices", { covered: false, subscriptions: [] }, [{ id: "inv" }]]
  ])(
    "does not claim there are no charges when the account has %s",
    async (_n, info, history) => {
      const result = await billing(
        billingApi({ result: info }, { result: history })
      );
      expect(result.billing.status).toBe("unavailable");
    }
  );

  it("reads a paid plan from a subscription", async () => {
    const result = await billing(
      billingApi(
        { result: { covered: true, subscriptions: [{}] } },
        { result: null }
      )
    );
    expect(result.plan).toBe("paid");
  });

  it("marks billing unavailable, with the status, when the API refuses", async () => {
    const result = await billing(billingApi({}, {}, 403));
    expect(result.billing).toEqual({
      status: "unavailable",
      reason: "HTTP 403"
    });
  });

  it("marks billing unavailable on an unexpected response", async () => {
    const result = await billing(billingApi({ result: {} }, { result: [] }));
    expect(result.billing).toEqual({
      status: "unavailable",
      reason: "billing data could not be read"
    });
  });
});

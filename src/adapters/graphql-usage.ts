import { z } from "zod";
import { isoDate, type IsoDate } from "../domain/periods";
import type { UsageRecord } from "../domain/usage";
import type { SourceStatus } from "../domain/usage-summary";
import type { Fetcher, UsageFetch, UsageSource } from "../ports/sources";

/**
 * Reads real usage from Cloudflare's GraphQL Analytics API (spec section 4).
 * It reports quantities, including usage inside free allowances, and no
 * costs. Each product is queried on its own so one failure cannot hide the
 * others, and a product that fails is reported as unavailable, never as zero.
 */

const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const ROW_LIMIT = 5_000;

type Metric = Readonly<{ field: string; metric: string; unit: string }>;

type Dataset = Readonly<{
  service: string;
  dataset: string;
  /** "sum" for totals, "max" for a level such as stored bytes. */
  aggregate: "sum";
  metrics: ReadonlyArray<Metric>;
}>;

// Field names confirmed against the account's GraphQL schema on 2026-10-05.
export const DATASETS: ReadonlyArray<Dataset> = [
  {
    service: "Workers AI",
    dataset: "aiInferenceAdaptiveGroups",
    aggregate: "sum",
    metrics: [{ field: "totalNeurons", metric: "neurons", unit: "neurons" }]
  },
  {
    service: "Workers",
    dataset: "workersInvocationsAdaptive",
    aggregate: "sum",
    metrics: [{ field: "requests", metric: "requests", unit: "requests" }]
  },
  {
    service: "Durable Objects",
    dataset: "durableObjectsInvocationsAdaptiveGroups",
    aggregate: "sum",
    metrics: [{ field: "requests", metric: "requests", unit: "requests" }]
  },
  {
    service: "Durable Objects",
    dataset: "durableObjectsPeriodicGroups",
    aggregate: "sum",
    metrics: [
      { field: "duration", metric: "duration", unit: "GB-s" },
      { field: "rowsRead", metric: "rows read", unit: "rows" },
      { field: "rowsWritten", metric: "rows written", unit: "rows" }
    ]
  },
  {
    service: "Workflows",
    dataset: "workflowsAdaptiveGroups",
    aggregate: "sum",
    metrics: [{ field: "stepCount", metric: "steps", unit: "steps" }]
  }
];

const RowSchema = z.object({
  dimensions: z.object({ date: z.string() }),
  sum: z.record(z.string(), z.number().nullable())
});

const ResponseSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        accounts: z.array(z.object({ rows: z.array(RowSchema) })).min(1)
      })
    })
    .nullable(),
  errors: z.array(z.object({ message: z.string() })).nullish()
});

function queryFor(dataset: Dataset): string {
  const fields = dataset.metrics.map((metric) => metric.field).join(" ");
  return `query($account: String!, $from: Date!, $to: Date!) {
    viewer { accounts(filter: { accountTag: $account }) {
      rows: ${dataset.dataset}(limit: ${ROW_LIMIT}, filter: { date_geq: $from, date_leq: $to }) {
        dimensions { date } ${dataset.aggregate} { ${fields} }
      }
    } }
  }`;
}

/** Sums rows that share a date, since a dataset can return several per day. */
function toRecords(
  dataset: Dataset,
  rows: ReadonlyArray<z.infer<typeof RowSchema>>
): UsageRecord[] {
  return dataset.metrics.flatMap((metric) => {
    const byDate = new Map<IsoDate, number>();
    for (const row of rows) {
      const date = isoDate(row.dimensions.date);
      byDate.set(date, (byDate.get(date) ?? 0) + (row.sum[metric.field] ?? 0));
    }
    return [...byDate].map(([date, quantity]) => ({
      date,
      service: dataset.service,
      metric: metric.metric,
      zone: null,
      quantity,
      unit: metric.unit,
      billableQuantity: null,
      costMicros: null
    }));
  });
}

type DatasetResult =
  | { ok: true; records: UsageRecord[] }
  | { ok: false; reason: string };

export class GraphqlUsageSource implements UsageSource {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init)
  ) {}

  private async fetchDataset(
    dataset: Dataset,
    from: IsoDate,
    to: IsoDate
  ): Promise<DatasetResult> {
    try {
      const response = await this.fetcher(GRAPHQL_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          query: queryFor(dataset),
          variables: { account: this.accountId, from, to }
        })
      });
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
      const body = ResponseSchema.parse(await response.json());
      const error = body.errors?.[0];
      if (error) return { ok: false, reason: error.message };
      const rows = body.data?.viewer.accounts[0]?.rows ?? [];
      return { ok: true, records: toRecords(dataset, rows) };
    } catch (error) {
      const reason =
        error instanceof z.ZodError ? "unexpected response" : "request failed";
      return { ok: false, reason };
    }
  }

  async fetchUsage(from: IsoDate, to: IsoDate): Promise<UsageFetch> {
    const results = await Promise.all(
      DATASETS.map(async (dataset) => ({
        dataset,
        result: await this.fetchDataset(dataset, from, to)
      }))
    );
    const services = [...new Set(DATASETS.map((dataset) => dataset.service))];
    const sources: SourceStatus[] = services.map((service) => {
      const failed = results.find(
        (entry) => entry.dataset.service === service && !entry.result.ok
      );
      return failed && !failed.result.ok
        ? { service, available: false, reason: failed.result.reason }
        : { service, available: true };
    });
    const available = new Set(
      sources
        .filter((source) => source.available)
        .map((source) => source.service)
    );
    // A product with any failed dataset contributes no rows at all.
    const records = results.flatMap((entry) =>
      entry.result.ok && available.has(entry.dataset.service)
        ? entry.result.records
        : []
    );
    return { records, sources };
  }
}

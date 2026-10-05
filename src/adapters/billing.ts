import { z } from "zod";
import type { BillingInfo, BillingSource, Fetcher } from "../ports/sources";

/**
 * Reads the account's billing status from the Cloudflare billing API.
 * Phase 3 answers one question: does this account have charges at all?
 * Reading the charges themselves waits for an account that has some, since
 * their record shape could not be observed (spec V1, V10).
 */

const API = "https://api.cloudflare.com/client/v4";

const InfoSchema = z.object({
  result: z.object({
    covered: z.boolean(),
    subscriptions: z.array(z.unknown())
  })
});

const HistorySchema = z.object({ result: z.array(z.unknown()).nullable() });

export class CloudflareBillingSource implements BillingSource {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly fetcher: Fetcher = (url, init) => fetch(url, init)
  ) {}

  private async get(path: string): Promise<unknown> {
    const response = await this.fetcher(
      `${API}/accounts/${this.accountId}${path}`,
      { headers: { authorization: `Bearer ${this.apiToken}` } }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  }

  async fetchBilling(): Promise<BillingInfo> {
    try {
      const [info, history] = await Promise.all([
        this.get("/billable-usage/info").then((body) => InfoSchema.parse(body)),
        this.get("/billing/history").then((body) => HistorySchema.parse(body))
      ]);
      const hasSubscription = info.result.subscriptions.length > 0;
      const hasInvoices = (history.result ?? []).length > 0;
      const hasCharges = info.result.covered || hasSubscription || hasInvoices;
      return {
        plan: hasSubscription ? "paid" : "free",
        billing: hasCharges
          ? {
              status: "unavailable",
              reason:
                "This account has billing data, which this version does not read yet."
            }
          : { status: "none" },
        invoices: []
      };
    } catch (error) {
      const reason =
        error instanceof Error && error.message.startsWith("HTTP ")
          ? error.message
          : "billing data could not be read";
      // Without billing data the plan is unknown; the free allowances are the
      // smaller ones, so they are the safer ones to show.
      return {
        plan: "free",
        billing: { status: "unavailable", reason },
        invoices: []
      };
    }
  }
}

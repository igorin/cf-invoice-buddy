import { describe, expect, it } from "vitest";
import {
  CREDIT_STATES,
  MAX_REASON_CHARS,
  OWNER_OUTCOMES,
  SUBMISSION,
  SUPPORT_URL,
  TEST_DATA_MARK,
  cleanReason,
  describeState,
  gatherCreditEvidence,
  isOwnerOutcome,
  renderCreditDraft
} from "../../src/domain/credit-draft";
import type { Explanation } from "../../src/domain/explain";
import { isoDate } from "../../src/domain/periods";

const spike: Explanation = {
  period: { start: isoDate("2026-09-01"), end: isoDate("2026-10-01") },
  partial: false,
  outcome: "explained",
  total: "$331.00",
  baseline: {
    months: ["2026-06", "2026-07", "2026-08"],
    total: "$151.00",
    difference: "$180.00",
    direction: "higher",
    percent: "119%"
  },
  services: [
    {
      service: "Workers",
      current: "$300.00",
      usual: "$120.00",
      difference: "$180.00",
      direction: "higher"
    },
    {
      service: "R2",
      current: "$31.00",
      usual: "$31.00",
      difference: "$0.00",
      direction: "same"
    }
  ],
  daily: [],
  findings: [
    {
      service: "Workers",
      statement: "Workers cost $200.00 on 2 days, against a usual $4.00 a day.",
      impact: "$180.00",
      evidence: [
        {
          date: isoDate("2026-09-02"),
          quantity: "90,000,000 requests",
          cost: "$90.00"
        },
        {
          date: isoDate("2026-09-03"),
          quantity: "110,000,000 requests",
          cost: "$110.00"
        }
      ]
    },
    {
      service: null,
      statement: "The period is one day longer than usual.",
      impact: "$1.00",
      evidence: []
    }
  ],
  unexplained: "$0.00",
  notes: []
};

const evidenceFor = (service: string, explanation = spike, test = false) => {
  const evidence = gatherCreditEvidence(explanation, service, test);
  if (evidence === null) throw new Error("no evidence");
  return evidence;
};

describe("gatherCreditEvidence (UC-3)", () => {
  it("collects the charge, the usual amount, the overage and the product's findings", () => {
    expect(evidenceFor("Workers")).toEqual({
      month: "2026-09",
      period: { start: "2026-09-01", lastDay: "2026-09-30" },
      partial: false,
      service: "Workers",
      charged: "$300.00",
      usual: "$120.00",
      baselineMonths: ["2026-06", "2026-07", "2026-08"],
      amount: "$180.00",
      basis: "account_data",
      findings: [spike.findings[0]],
      testData: false
    });
  });

  it("matches the product name without regard to case or spaces", () => {
    expect(evidenceFor("  workers ").service).toBe("Workers");
  });

  it("returns nothing for a product with no charges in the period", () => {
    expect(gatherCreditEvidence(spike, "Stream", false)).toBeNull();
  });

  it("states no amount and rests on the owner's word when the data shows no increase", () => {
    const evidence = evidenceFor("R2");
    expect(evidence.amount).toBeNull();
    expect(evidence.basis).toBe("owner_statement");
    expect(evidence.findings).toEqual([]);
  });

  it("does not count a finding about the whole account as support for one product", () => {
    expect(evidenceFor("R2").findings).toEqual([]);
  });

  it("states no amount when the product costs less than usual", () => {
    const lower: Explanation = {
      ...spike,
      findings: [],
      services: [
        {
          service: "Workers",
          current: "$100.00",
          usual: "$120.00",
          difference: "$20.00",
          direction: "lower"
        }
      ]
    };
    expect(evidenceFor("Workers", lower).amount).toBeNull();
  });

  it("copes with a period that has nothing to compare with", () => {
    const alone: Explanation = {
      ...spike,
      baseline: null,
      findings: [],
      services: [
        {
          service: "Workers",
          current: "$300.00",
          usual: null,
          difference: null,
          direction: null
        }
      ]
    };
    expect(evidenceFor("Workers", alone)).toMatchObject({
      usual: null,
      baselineMonths: [],
      amount: null,
      basis: "owner_statement"
    });
  });
});

describe("renderCreditDraft (UC-3)", () => {
  const reason = "A misconfigured Worker looped for two days.";

  it("writes the request from the evidence, with every figure from it", () => {
    expect(renderCreditDraft(evidenceFor("Workers"), reason)).toBe(
      [
        "Subject: Billing credit request: Workers, 2026-09",
        "I am requesting a billing credit for Workers usage in 2026-09 (2026-09-01 to 2026-09-30).",
        "Amount requested: $180.00\nThis is the Workers charge for the period ($300.00) less the usual amount ($120.00, from 2026-06, 2026-07, 2026-08).",
        'Reason, in the account owner\'s words: "A misconfigured Worker looped for two days."',
        "Evidence from the account's usage data:\n- Workers cost $200.00 on 2 days, against a usual $4.00 a day. Impact: $180.00.\n  - 2026-09-02: 90,000,000 requests, $90.00\n  - 2026-09-03: 110,000,000 requests, $110.00",
        "Figures are from the account's usage data as read by the account owner's billing assistant. They have not been checked by Cloudflare."
      ].join("\n\n")
    );
  });

  it("says the claim rests on the owner's statement when no anomaly was found", () => {
    const draft = renderCreditDraft(evidenceFor("R2"), reason);
    expect(draft).toContain("Amount requested: not stated.");
    expect(draft).toContain(
      "The account's data shows no increase for R2: the charge for the period is $31.00 and the usual amount is $31.00"
    );
    expect(draft).toContain(
      "shows no anomaly for R2 in this period. This request rests on the account owner's statement above."
    );
    expect(draft).not.toContain("Evidence from the account's usage data:");
  });

  it("says there is nothing to compare with when there is no earlier period", () => {
    const alone: Explanation = {
      ...spike,
      baseline: null,
      findings: [],
      services: [
        {
          service: "Workers",
          current: "$300.00",
          usual: null,
          difference: null,
          direction: null
        }
      ]
    };
    expect(renderCreditDraft(evidenceFor("Workers", alone), reason)).toContain(
      "The Workers charge for the period is $300.00. There is no earlier period in the account's data to compare it with."
    );
  });

  it("marks a draft made from test data, first, so it cannot be missed", () => {
    const draft = renderCreditDraft(
      evidenceFor("Workers", spike, true),
      reason
    );
    expect(draft.startsWith(`${TEST_DATA_MARK}\n\n`)).toBe(true);
    expect(renderCreditDraft(evidenceFor("Workers"), reason)).not.toContain(
      TEST_DATA_MARK
    );
  });

  it("says so when the period is still open", () => {
    const open = { ...spike, partial: true };
    expect(renderCreditDraft(evidenceFor("Workers", open), reason)).toContain(
      "The period is still open."
    );
  });

  it("quotes the owner's reason on one line and says when there is none", () => {
    expect(
      renderCreditDraft(evidenceFor("Workers"), "  it looped\n\nfor days ")
    ).toContain('in the account owner\'s words: "it looped for days"');
    expect(renderCreditDraft(evidenceFor("Workers"), "  ")).toContain(
      "Reason: the account owner gave no reason."
    );
  });
});

describe("cleanReason", () => {
  it("cuts a very long reason", () => {
    expect(cleanReason("x".repeat(5_000))).toHaveLength(MAX_REASON_CHARS);
  });
});

describe("submission instructions (UC-3, G-7)", () => {
  it("are fixed text with Cloudflare's support page as the only link", () => {
    expect(SUBMISSION.url).toBe(SUPPORT_URL);
    expect(SUPPORT_URL).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
    expect(SUBMISSION.steps.join(" ")).toContain("Create a Case");
    expect(SUBMISSION.note).toContain("cannot submit");
  });

  it("were checked against that page within the last 90 days", () => {
    const ageMs = Date.now() - Date.parse(SUBMISSION.checkedOn);
    expect(ageMs).toBeGreaterThanOrEqual(0);
    expect(ageMs).toBeLessThan(90 * 24 * 3_600_000);
  });
});

describe("credit request states (UC-4)", () => {
  it("describes every state, and marks every outcome as the owner's report", () => {
    for (const state of CREDIT_STATES) {
      expect(describeState(state).length).toBeGreaterThan(0);
    }
    for (const state of Object.values(OWNER_OUTCOMES)) {
      expect(describeState(state)).toContain(
        "as reported by the account owner"
      );
    }
    expect(describeState("drafted")).toContain("Not known to be submitted");
  });

  it("recognises only the outcomes an owner can report", () => {
    expect(isOwnerOutcome("approved")).toBe(true);
    expect(isOwnerOutcome("superseded")).toBe(false);
    expect(isOwnerOutcome("drafted")).toBe(false);
    expect(isOwnerOutcome(7)).toBe(false);
  });
});

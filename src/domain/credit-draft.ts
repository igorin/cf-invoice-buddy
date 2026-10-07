import type { Explanation } from "./explain";

/**
 * The credit request draft (spec UC-3). The draft is a fixed template filled
 * from the account's stored data; the model does not write it. The assistant
 * never submits anything: the owner does, following the instructions below.
 */

/** Cloudflare's page on opening a support case. On the fixed link list (G-7). */
export const SUPPORT_URL =
  "https://developers.cloudflare.com/support/contacting-cloudflare-support/";

/** How to submit, taken from that page. Reviewed text; never model-written. */
export const SUBMISSION = {
  steps: [
    "In the Cloudflare dashboard, go to the Support page and select the account.",
    "Click Billing, then click Create a Case at the bottom of the next screen.",
    "Choose the category and subcategories that best describe the issue.",
    "Paste the draft as the summary of the issue, and fill in the remaining fields.",
    "Click Submit Case."
  ],
  url: SUPPORT_URL,
  checkedOn: "2026-10-07",
  note: "This assistant cannot submit the request or see Cloudflare's decision. You submit it, and Cloudflare replies to you directly. Billing cases are open to accounts on the Free plan."
} as const;

export const TEST_DATA_MARK = "Test data. Do not submit.";

/** The owner's reason is kept to a length a support case can use. */
export const MAX_REASON_CHARS = 1_000;

/** Whether the account's data supports the claim, or only the owner's word. */
export type CreditBasis = "account_data" | "owner_statement";

export type CreditEvidence = Readonly<{
  month: string;
  period: Readonly<{ start: string; lastDay: string }>;
  partial: boolean;
  service: string;
  charged: string;
  usual: string | null;
  baselineMonths: ReadonlyArray<string>;
  /** The charge above the usual amount; null when there is none to state. */
  amount: string | null;
  basis: CreditBasis;
  findings: Explanation["findings"];
  testData: boolean;
}>;

const lastDayOf = (end: string): string => {
  const day = new Date(`${end}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
};

/**
 * Collects what the account's data says about one product in one period.
 * Returns null when the product has no charges or usage in that period.
 * The name is matched without regard to case.
 */
export function gatherCreditEvidence(
  explanation: Explanation,
  service: string,
  testData: boolean
): CreditEvidence | null {
  const wanted = service.trim().toLowerCase();
  const line = explanation.services.find(
    (candidate) => candidate.service.toLowerCase() === wanted
  );
  if (line === undefined) return null;
  const findings = explanation.findings.filter(
    (finding) =>
      finding.service !== null && finding.service.toLowerCase() === wanted
  );
  return {
    month: explanation.period.start.slice(0, 7),
    period: {
      start: explanation.period.start,
      lastDay: lastDayOf(explanation.period.end)
    },
    partial: explanation.partial,
    service: line.service,
    charged: line.current,
    usual: line.usual,
    baselineMonths: explanation.baseline?.months ?? [],
    amount: line.direction === "higher" ? line.difference : null,
    basis: findings.length > 0 ? "account_data" : "owner_statement",
    findings,
    testData
  };
}

/** Trims the owner's reason and removes line breaks, for quoting on one line. */
export function cleanReason(reason: string): string {
  return reason.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS);
}

function amountLines(evidence: CreditEvidence): string[] {
  const { service, charged, usual, amount, baselineMonths } = evidence;
  if (amount !== null && usual !== null) {
    return [
      `Amount requested: ${amount}`,
      `This is the ${service} charge for the period (${charged}) less the usual amount (${usual}, from ${baselineMonths.join(", ")}).`
    ];
  }
  if (usual === null) {
    return [
      "Amount requested: not stated.",
      `The ${service} charge for the period is ${charged}. There is no earlier period in the account's data to compare it with.`
    ];
  }
  return [
    "Amount requested: not stated.",
    `The account's data shows no increase for ${service}: the charge for the period is ${charged} and the usual amount is ${usual} (from ${baselineMonths.join(", ")}).`
  ];
}

function evidenceLines(evidence: CreditEvidence): string[] {
  if (evidence.basis === "owner_statement") {
    return [
      `The account's usage data shows no anomaly for ${evidence.service} in this period. This request rests on the account owner's statement above.`
    ];
  }
  return [
    "Evidence from the account's usage data:",
    ...evidence.findings.flatMap((finding) => [
      `- ${finding.statement} Impact: ${finding.impact}.`,
      ...finding.evidence.map(
        (item) => `  - ${item.date}: ${item.quantity}, ${item.cost}`
      )
    ])
  ];
}

/** Fills the template. Every figure comes from `evidence`. */
export function renderCreditDraft(
  evidence: CreditEvidence,
  ownerReason: string
): string {
  const reason = cleanReason(ownerReason);
  const paragraphs: string[][] = [
    ...(evidence.testData ? [[TEST_DATA_MARK]] : []),
    [`Subject: Billing credit request: ${evidence.service}, ${evidence.month}`],
    [
      `I am requesting a billing credit for ${evidence.service} usage in ${evidence.month} (${evidence.period.start} to ${evidence.period.lastDay}).`
    ],
    amountLines(evidence),
    [
      reason === ""
        ? "Reason: the account owner gave no reason."
        : `Reason, in the account owner's words: "${reason}"`
    ],
    evidenceLines(evidence),
    ...(evidence.partial
      ? [
          [
            "The period is still open. The figures cover usage to the date this draft was written."
          ]
        ]
      : []),
    [
      "Figures are from the account's usage data as read by the account owner's billing assistant. They have not been checked by Cloudflare."
    ]
  ];
  return paragraphs.map((lines) => lines.join("\n")).join("\n\n");
}

/** What can happen to a draft. Everything after `drafted` is the owner's report. */
export const CREDIT_STATES = [
  "drafted",
  "reported_submitted",
  "reported_approved",
  "reported_partially_approved",
  "reported_denied",
  "superseded"
] as const;

export type CreditState = (typeof CREDIT_STATES)[number];

/** The outcomes an owner can report, as the owner would say them. */
export const OWNER_OUTCOMES = {
  submitted: "reported_submitted",
  approved: "reported_approved",
  partially_approved: "reported_partially_approved",
  denied: "reported_denied"
} as const satisfies Record<string, CreditState>;

export type OwnerOutcome = keyof typeof OWNER_OUTCOMES;

export const isOwnerOutcome = (value: unknown): value is OwnerOutcome =>
  typeof value === "string" && value in OWNER_OUTCOMES;

/** A state in words, saying whose word it rests on. */
export function describeState(state: CreditState): string {
  switch (state) {
    case "drafted":
      return "Drafted. Not known to be submitted.";
    case "reported_submitted":
      return "Submitted, as reported by the account owner.";
    case "reported_approved":
      return "Approved, as reported by the account owner.";
    case "reported_partially_approved":
      return "Partially approved, as reported by the account owner.";
    case "reported_denied":
      return "Denied, as reported by the account owner.";
    case "superseded":
      return "Replaced by a later draft.";
  }
}

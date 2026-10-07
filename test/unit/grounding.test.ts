import { describe, expect, it } from "vitest";
import {
  CANNOT_EXPLAIN,
  SPECULATION_LABEL,
  checkGrounding,
  type GroundingInput
} from "../../src/domain/grounding";

const DOCS = "https://developers.cloudflare.com/workers-ai/platform/pricing/";

const toolResult = {
  total: "$217.00",
  baseline: {
    total: "$25.00",
    difference: "$192.00",
    percent: "768.0%",
    months: ["2026-09"]
  },
  findings: [
    {
      statement:
        "Workers cost $200.00 over 2 days (2026-10-01 to 2026-10-02), against a usual $4.00 a day: $192.00 above usual.",
      evidence: [
        { date: "2026-10-01", quantity: "90,000,000 requests", cost: "$90.00" }
      ]
    }
  ]
};

function input(
  text: string,
  overrides: Partial<GroundingInput> = {}
): GroundingInput {
  return {
    text,
    toolResults: [toolResult],
    ownerText: "Why is my bill higher than usual?",
    docsUrls: [],
    allowedUrls: [],
    explainOutcome: "explained",
    ...overrides
  };
}

const rules = (text: string, overrides: Partial<GroundingInput> = {}) =>
  checkGrounding(input(text, overrides)).map((violation) => violation.rule);

describe("figures (G-1)", () => {
  it("accepts a reply whose every figure is in the tool results", () => {
    const text =
      "Your bill is $217.00, which is $192.00 (768.0%) higher than 2026-09. Workers cost $200.00 over 2 days, with 90,000,000 requests on 2026-10-01 costing $90.00.";
    expect(checkGrounding(input(text))).toEqual([]);
  });

  it.each([
    ["an amount", "Your bill is $412.00."],
    ["a percentage", "That is 55.5% higher."],
    ["a date", "The spike was on 2026-10-09."],
    ["a month", "Compared with 2026-08."],
    ["a quantity", "There were 91,000,000 requests."],
    ["a decimal quantity", "You used 311.15 neurons."]
  ])("flags %s that is in no tool result", (_name, text) => {
    expect(rules(text)).toEqual(["G-1"]);
  });

  it("names the figure it could not find", () => {
    expect(checkGrounding(input("Your bill is $412.00."))[0]?.detail).toContain(
      "$412.00"
    );
  });

  it("does not accept a figure that is only part of a longer one", () => {
    // "$17.00" appears inside "$217.00" but was never stated by a tool.
    expect(rules("Your bill is $17.00.")).toEqual(["G-1"]);
  });

  it("accepts an amount or percentage written without its trailing zeros", () => {
    expect(rules("Your bill is $217, which is 768% higher.")).toEqual([]);
  });

  it("accepts a figure the owner gave, since repeating it is not inventing it", () => {
    const text = "You mentioned $412, but the account shows $217.00.";
    expect(
      rules(text, { ownerText: "Why is my bill $412 when it's usually $150?" })
    ).toEqual([]);
  });

  it("ignores small whole numbers, which are words more than figures", () => {
    expect(
      rules("Workers cost $200.00 over 2 days; here are 3 things to check.")
    ).toEqual([]);
  });

  it("flags every figure when no tool was called at all", () => {
    expect(rules("Your bill is $217.00.", { toolResults: [] })).toEqual([
      "G-1"
    ]);
  });

  it("reports the same missing figure once", () => {
    expect(rules("It is $412.00. Yes, $412.00.")).toEqual(["G-1"]);
  });
});

describe("links (G-7)", () => {
  it("accepts a link returned by the documentation search", () => {
    const text = `${SPECULATION_LABEL}: Workers AI bills in neurons (${DOCS}).`;
    expect(rules(text, { docsUrls: [DOCS] })).toEqual([]);
  });

  it("accepts a link from the fixed list", () => {
    const support =
      "https://developers.cloudflare.com/support/contacting-cloudflare-support/";
    expect(rules(`See ${support}.`, { allowedUrls: [support] })).toEqual([]);
  });

  it("flags a link the model composed", () => {
    expect(
      rules(
        "See https://developers.cloudflare.com/billing/secret-discounts/ for more."
      )
    ).toEqual(["G-7"]);
  });

  it("is not confused by punctuation after a link", () => {
    const text = `${SPECULATION_LABEL}, see ${DOCS}, ${DOCS}. ${SPECULATION_LABEL} too (${DOCS})!`;
    expect(rules(text, { docsUrls: [DOCS] })).toEqual([]);
  });
});

describe("speculation label (G-3)", () => {
  it("flags a documentation link in a sentence without the label", () => {
    const text = `Workers AI bills in neurons, see ${DOCS}. That is all.`;
    expect(rules(text, { docsUrls: [DOCS] })).toEqual(["G-3"]);
  });

  it("requires the label in the same sentence as the link, not elsewhere", () => {
    const text = `${SPECULATION_LABEL}. Workers AI bills in neurons, see ${DOCS}.`;
    expect(rules(text, { docsUrls: [DOCS] })).toEqual(["G-3"]);
  });

  it("does not ask for the label on a link from the fixed list", () => {
    const support =
      "https://developers.cloudflare.com/support/contacting-cloudflare-support/";
    expect(
      rules(`Submit it at ${support}.`, { allowedUrls: [support] })
    ).toEqual([]);
  });
});

describe("no cause without findings (G-2, G-4)", () => {
  const none = { explainOutcome: "none_found" as const };

  it("accepts the breakdown followed by the cannot-explain sentence", () => {
    const text = `Your bill is $217.00, which is $192.00 higher. ${CANNOT_EXPLAIN}`;
    expect(rules(text, none)).toEqual([]);
  });

  it("flags a reply that leaves the sentence out", () => {
    expect(
      rules("Your bill is $217.00, which is $192.00 higher.", none)
    ).toEqual(["G-4"]);
  });

  it.each([
    "because",
    "due to",
    "likely",
    "probably",
    "caused by",
    "possibly",
    "may be"
  ])("flags a cause offered with %j", (phrase) => {
    const text = `Your bill is $217.00, ${phrase} more traffic. ${CANNOT_EXPLAIN}`;
    expect(rules(text, none)).toEqual(["G-4"]);
  });

  it("allows a documentation-based cause, which G-3 governs instead", () => {
    const text = `Your bill is $217.00. ${SPECULATION_LABEL}: it may be due to neurons, see ${DOCS}.`;
    expect(rules(text, { ...none, docsUrls: [DOCS] })).toEqual([]);
  });

  it("does not apply when findings were returned", () => {
    expect(rules("Your bill is $217.00 because Workers cost $200.00.")).toEqual(
      []
    );
  });
});

describe("checkGrounding", () => {
  it("returns nothing for a reply with no figures and no links", () => {
    expect(
      checkGrounding(
        input("I can only help with Cloudflare billing.", { toolResults: [] })
      )
    ).toEqual([]);
  });

  it("reports violations of several rules together", () => {
    const text = "Your bill is $999.00, see https://example.com/why.";
    expect(rules(text)).toEqual(["G-1", "G-7"]);
  });
});

describe("claims of submitting a credit request (UC-3)", () => {
  const rules = (text: string) =>
    checkGrounding(input(text)).map((violation) => violation.rule);

  it.each([
    "I have submitted the request to Cloudflare.",
    "I've submitted it for you.",
    "I submitted your credit request.",
    "I will submit the request now.",
    "I'll submit this to Cloudflare support.",
    "I can submit it on your behalf.",
    "I have now filed the case.",
    "I just sent the request."
  ])("flags %j", (text) => {
    expect(rules(text)).toEqual(["UC-3"]);
  });

  it.each([
    "I cannot submit the request; you submit it from the dashboard.",
    "I can't submit it for you.",
    "This is a draft. Submit it yourself with the steps in the card.",
    "As you reported, the request was submitted.",
    "You told me it has been submitted and approved.",
    "I have drafted the request."
  ])("allows %j", (text) => {
    expect(rules(text)).toEqual([]);
  });
});

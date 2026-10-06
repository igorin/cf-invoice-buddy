/**
 * The response checker (spec section 7). It compares what the model wrote
 * with what the tools returned in the same turn and reports any breach of
 * the grounding rules. It runs after every reply; prompting alone is not
 * relied on.
 */

/** The wording the model is told to use; the checker looks for the same. */
export const CANNOT_EXPLAIN =
  "I can't explain this difference from the account's data.";
export const SPECULATION_LABEL = "This is speculation";

export type GroundingInput = Readonly<{
  text: string;
  /** Every tool result of the turn. */
  toolResults: ReadonlyArray<unknown>;
  /** The owner's message, whose own figures may be repeated back. */
  ownerText: string;
  /** Links returned by the documentation search this turn. */
  docsUrls: ReadonlyArray<string>;
  /** Links the app itself may give, such as the support page. */
  allowedUrls: ReadonlyArray<string>;
  /** The outcome of explainBillChange this turn, if it was called. */
  explainOutcome: string | null;
}>;

export type Violation = Readonly<{
  rule: "G-1" | "G-3" | "G-4" | "G-7";
  detail: string;
}>;

// Dates, months, dollar amounts, percentages, numbers with a thousands
// separator and decimals. Small whole numbers ("2 days") are left alone.
const FIGURE =
  /\d{4}-\d{2}-\d{2}|\d{4}-\d{2}(?!\d)|-?\$[\d,]*\d(?:\.\d+)?|\d[\d,]*(?:\.\d+)?%|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+/g;
const URL = /https?:\/\/[^\s)<>"']+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const SENTENCE_END = /(?<=[.!?])\s+/;
const CAUSAL_PHRASE =
  /\b(because|due to|likely|probably|caused by|possibly|perhaps|may be|might be|could be)\b/i;

const escape = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when the figure stands on its own in the text, not inside a longer number. */
function contains(haystack: string, figure: string): boolean {
  return new RegExp(`(?<![\\d.,])${escape(figure)}(?![\\d]|[.,]\\d)`).test(
    haystack
  );
}

/** A figure, and the same figure with the trailing zeros the tools print. */
function variants(figure: string): string[] {
  if (figure.includes(".")) return [figure];
  if (figure.endsWith("%")) return [figure, `${figure.slice(0, -1)}.0%`];
  if (figure.includes("$")) return [figure, `${figure}.00`];
  return [figure];
}

function ungroundedFigures(input: GroundingInput): string[] {
  const known = `${JSON.stringify(input.toolResults)} ${input.ownerText}`;
  const figures = [
    ...new Set(input.text.replace(URL, " ").match(FIGURE) ?? [])
  ];
  return figures.filter(
    (figure) => !variants(figure).some((variant) => contains(known, variant))
  );
}

const urlsIn = (text: string): string[] =>
  (text.match(URL) ?? []).map((url) => url.replace(TRAILING_PUNCTUATION, ""));

function unlabelledDocsLinks(input: GroundingInput): string[] {
  // Links contain full stops, so they are swapped for markers before the
  // text is split into sentences.
  const links: string[] = [];
  const marked = input.text.replace(URL, (match) => {
    const url = match.replace(TRAILING_PUNCTUATION, "");
    links.push(url);
    return `\uE000${links.length - 1}\uE000${match.slice(url.length)}`;
  });
  return marked.split(SENTENCE_END).flatMap((sentence) => {
    const indexes = [...sentence.matchAll(/\uE000(\d+)\uE000/g)].map((m) =>
      Number(m[1])
    );
    const docs = indexes
      .map((index) => links[index] ?? "")
      .filter((url) => input.docsUrls.includes(url));
    return docs.length > 0 && !sentence.includes(SPECULATION_LABEL) ? docs : [];
  });
}

function causeWithoutFinding(input: GroundingInput): string | null {
  if (input.explainOutcome !== "none_found" || input.docsUrls.length > 0)
    return null;
  if (!input.text.includes(CANNOT_EXPLAIN)) {
    return "no cause was found, but the reply does not say it cannot explain the difference";
  }
  const phrase = CAUSAL_PHRASE.exec(input.text)?.[0];
  return phrase
    ? `no cause was found, but the reply offers one ("${phrase}")`
    : null;
}

export function checkGrounding(input: GroundingInput): Violation[] {
  const violations: Violation[] = [];

  const figures = ungroundedFigures(input);
  if (figures.length > 0) {
    violations.push({
      rule: "G-1",
      detail: `figures not in any tool result: ${figures.join(", ")}`
    });
  }

  const unlabelled = unlabelledDocsLinks(input);
  if (unlabelled.length > 0) {
    violations.push({
      rule: "G-3",
      detail: `documentation link without the speculation label: ${unlabelled.join(", ")}`
    });
  }

  const cause = causeWithoutFinding(input);
  if (cause) violations.push({ rule: "G-4", detail: cause });

  const permitted = new Set([...input.docsUrls, ...input.allowedUrls]);
  const composed = [...new Set(urlsIn(input.text))].filter(
    (url) => !permitted.has(url)
  );
  if (composed.length > 0) {
    violations.push({
      rule: "G-7",
      detail: `links not from a tool result: ${composed.join(", ")}`
    });
  }

  return violations;
}

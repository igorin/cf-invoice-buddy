import {
  compareToBaseline,
  dailyCost,
  totalCost,
  totalsByService
} from "./breakdown";
import { runDetectors } from "./detectors";
import type { Finding } from "./findings";
import { formatUsd, micros, type Micros } from "./money";
import { addDays, isOpen, type BillingPeriod, type IsoDate } from "./periods";
import type { UsageRecord } from "./usage";
import type { BillingState } from "./usage-summary";

/**
 * Builds a bill explanation (spec UC-1, UC-2). The result is what the model
 * is given and what the breakdown card renders, so every figure is already
 * text (rule G-1) and every cause comes from a detector (rule G-2).
 */

// Limits that keep the result inside the model's small context window.
const MAX_SERVICES = 8;
const MAX_DAILY_SERIES = 3;
const MS_PER_DAY = 86_400_000;

type PeriodRecords = Readonly<{
  period: BillingPeriod;
  records: ReadonlyArray<UsageRecord>;
}>;

export type ExplainInput = Readonly<{
  period: BillingPeriod;
  today: IsoDate;
  current: ReadonlyArray<UsageRecord>;
  baseline: Readonly<{
    periods: ReadonlyArray<PeriodRecords>;
    /** True when the owner named the month, so a single month is enough. */
    chosenByOwner: boolean;
  }>;
  invoiceMicros: Micros | null;
  billing: BillingState;
}>;

type Direction = "higher" | "lower" | "same";

export type Explanation = Readonly<{
  period: BillingPeriod;
  partial: boolean;
  /**
   * no_charges: nothing was billed. no_baseline: nothing to compare with.
   * explained: at least one finding. none_found: a difference, no finding.
   */
  outcome: "no_charges" | "no_baseline" | "explained" | "none_found";
  total: string;
  baseline: Readonly<{
    months: ReadonlyArray<string>;
    total: string;
    difference: string;
    direction: Direction;
    percent: string | null;
  }> | null;
  services: ReadonlyArray<
    Readonly<{
      service: string;
      current: string;
      usual: string | null;
      difference: string | null;
      direction: Direction | null;
    }>
  >;
  daily: ReadonlyArray<
    Readonly<{
      service: string;
      days: ReadonlyArray<Readonly<{ date: IsoDate; cost: string }>>;
    }>
  >;
  findings: ReadonlyArray<
    Readonly<{
      /** Null for a finding about the whole account. */
      service: string | null;
      statement: string;
      impact: string;
      evidence: ReadonlyArray<
        Readonly<{ date: IsoDate; quantity: string; cost: string }>
      >;
    }>
  >;
  unexplained: string | null;
  notes: ReadonlyArray<string>;
}>;

const directionOf = (delta: number): Direction =>
  delta > 0 ? "higher" : delta < 0 ? "lower" : "same";

const absolute = (value: Micros): string => formatUsd(micros(Math.abs(value)));

const quantityText = (value: number, unit: string): string =>
  `${value.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${unit}`;

function daysElapsed(period: BillingPeriod, today: IsoDate): number {
  const start = Date.parse(`${period.start}T00:00:00Z`);
  return (
    Math.round((Date.parse(`${today}T00:00:00Z`) - start) / MS_PER_DAY) + 1
  );
}

/** The first `days` days of a period, so an open period is compared like with like. */
function firstDays(source: PeriodRecords, days: number): PeriodRecords {
  const end = addDays(source.period.start, days);
  if (end >= source.period.end) return source;
  return {
    period: { start: source.period.start, end },
    records: source.records.filter((record) => record.date < end)
  };
}

function describeFinding(finding: Finding): Explanation["findings"][number] {
  return {
    service: finding.service,
    statement: finding.statement,
    impact: absolute(finding.impactMicros),
    evidence: finding.evidence.map((item) => ({
      date: item.date,
      quantity: quantityText(item.quantity, item.unit),
      cost: formatUsd(item.costMicros)
    }))
  };
}

function notesFor(
  input: ExplainInput,
  partial: boolean,
  elapsed: number,
  hasBaseline: boolean
): string[] {
  const notes: string[] = [];
  if (partial) {
    notes.push(
      hasBaseline
        ? `This period is still open. Figures cover its first ${elapsed} days and are compared with the first ${elapsed} days of each baseline month.`
        : `This period is still open. Figures cover its first ${elapsed} days.`
    );
  }
  if (!hasBaseline) {
    notes.push(
      "There is no earlier month to compare with. Name a month to compare against."
    );
  }
  const uncosted = totalCost(input.current).uncostedRecords;
  if (input.billing.status === "unavailable") {
    notes.push(`Billed amounts could not be read: ${input.billing.reason}`);
  } else if (input.billing.status === "costed" && uncosted > 0) {
    notes.push(
      `${uncosted} usage record${uncosted === 1 ? " has" : "s have"} no cost from the billing source and ${uncosted === 1 ? "is" : "are"} left out of the amounts.`
    );
  }
  return notes;
}

export function explainBill(input: ExplainInput): Explanation {
  const partial = isOpen(input.period, input.today);
  const elapsed = daysElapsed(input.period, input.today);
  const baselines = partial
    ? input.baseline.periods.map((source) => firstDays(source, elapsed))
    : input.baseline.periods;
  const minPeriods = input.baseline.chosenByOwner ? 1 : undefined;
  const total = totalCost(input.current).costMicros;

  if (input.billing.status === "none" && total === 0) {
    return {
      period: input.period,
      partial,
      outcome: "no_charges",
      total: formatUsd(total),
      baseline: null,
      services: [],
      daily: [],
      findings: [],
      unexplained: null,
      notes: ["This account has no usage-based subscription and no invoices."]
    };
  }

  const comparison = compareToBaseline(
    input.current,
    baselines.map((b) => b.records),
    minPeriods
  );
  const detected = runDetectors({
    period: partial
      ? { start: input.period.start, end: addDays(input.period.start, elapsed) }
      : input.period,
    current: input.current,
    baselines,
    invoiceMicros: input.invoiceMicros,
    ...(minPeriods === undefined ? {} : { minBaselinePeriods: minPeriods })
  });

  const services = comparison.comparable
    ? comparison.services.map((service) => ({
        service: service.service,
        current: formatUsd(service.currentMicros),
        usual: formatUsd(service.baselineMicros),
        difference: absolute(service.deltaMicros),
        direction: directionOf(service.deltaMicros)
      }))
    : totalsByService(input.current).map((service) => ({
        service: service.service,
        current: formatUsd(service.costMicros),
        usual: null,
        difference: null,
        direction: null
      }));

  return {
    period: input.period,
    partial,
    outcome: !comparison.comparable
      ? "no_baseline"
      : detected.findings.length > 0
        ? "explained"
        : "none_found",
    total: formatUsd(total),
    baseline: comparison.comparable
      ? {
          months: baselines.map((b) => b.period.start.slice(0, 7)),
          total: formatUsd(comparison.baselineMicros),
          difference: absolute(comparison.deltaMicros),
          direction: directionOf(comparison.deltaMicros),
          percent:
            comparison.percent === null
              ? null
              : `${Math.abs(comparison.percent).toFixed(1)}%`
        }
      : null,
    services: services.slice(0, MAX_SERVICES),
    daily: services.slice(0, MAX_DAILY_SERIES).map((service) => ({
      service: service.service,
      days: dailyCost(input.current, service.service).map((day) => ({
        date: day.date,
        cost: formatUsd(day.costMicros)
      }))
    })),
    findings: detected.findings.map(describeFinding),
    unexplained:
      detected.unexplainedMicros === null
        ? null
        : formatUsd(detected.unexplainedMicros),
    notes: notesFor(input, partial, elapsed, comparison.comparable)
  };
}

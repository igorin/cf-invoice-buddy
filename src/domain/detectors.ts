import { compareToBaseline, type ServiceDelta } from "./breakdown";
import { formatUsd, micros, type Micros } from "./money";
import type {
  DetectorId,
  DetectorInput,
  DetectorResult,
  Evidence,
  Finding
} from "./findings";
import { daysInPeriod, type IsoDate } from "./periods";
import { reconcile } from "./reconcile";
import type { UsageRecord } from "./usage";

export type {
  DetectorId,
  DetectorInput,
  DetectorResult,
  Evidence,
  Finding
} from "./findings";

/**
 * Anomaly detectors (spec section 6). Each is a pure function from a
 * period's usage and its baseline periods to findings with evidence.
 * A finding's statement is built here from a template, never by the model,
 * and a cause is only ever stated when a detector produced it (G-2).
 */

// A day costing this many times the usual daily cost is a spike.
const SPIKE_MULTIPLE = 3;
// A service costing this fraction of its usual, or less, has dropped.
const DROP_RATIO = 0.5;
// Changes smaller than this are not worth a finding.
const MIN_IMPACT_MICROS = 1_000_000;
const LOW_DAYS_SHOWN = 3;

type Records = ReadonlyArray<UsageRecord>;

// The detectors whose impacts are counted against a service's change.
const SERVICE_LEVEL: ReadonlySet<DetectorId> = new Set([
  "usage-spike",
  "usage-drop",
  "new-service",
  "removed-service"
]);

const costOf = (records: Records): number =>
  records.reduce((total, record) => total + (record.costMicros ?? 0), 0);

const unique = <T>(values: ReadonlyArray<T>): T[] => [...new Set(values)];

const mean = (values: ReadonlyArray<number>): number =>
  values.reduce((total, value) => total + value, 0) / values.length;

function median(values: ReadonlyArray<number>): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  return sorted.length % 2 === 1
    ? upper
    : (upper + (sorted[middle - 1] ?? 0)) / 2;
}

function dailyTotals(records: Records): Map<IsoDate, number> {
  const totals = new Map<IsoDate, number>();
  for (const record of records) {
    totals.set(
      record.date,
      (totals.get(record.date) ?? 0) + (record.costMicros ?? 0)
    );
  }
  return totals;
}

/** One evidence row per date: the day's cost and its largest metric's quantity. */
function evidenceFor(
  records: Records,
  dates: ReadonlyArray<IsoDate>
): Evidence[] {
  return dates.flatMap((date) => {
    const onDate = records.filter((record) => record.date === date);
    return [...onDate]
      .sort((a, b) => (b.costMicros ?? 0) - (a.costMicros ?? 0))
      .slice(0, 1)
      .map((largest) => ({
        date,
        quantity: largest.quantity,
        unit: largest.unit,
        costMicros: micros(costOf(onDate))
      }));
  });
}

function finding(
  detector: DetectorId,
  service: string | null,
  impact: number,
  evidence: ReadonlyArray<Evidence>,
  statement: string
): Finding {
  return {
    detector,
    kind: "account_data",
    direction: impact >= 0 ? "increase" : "decrease",
    service,
    impactMicros: micros(Math.round(impact)),
    evidence,
    statement
  };
}

const usd = (amount: number): string => formatUsd(micros(Math.round(amount)));

function detectSpikes(input: DetectorInput): Finding[] {
  const baseline = input.baselines.flatMap((b) => b.records);
  return unique(input.current.map((r) => r.service)).flatMap((service) => {
    const usual = median([
      ...dailyTotals(baseline.filter((r) => r.service === service)).values()
    ]);
    if (usual <= 0) return [];
    const ofService = input.current.filter((r) => r.service === service);
    const spikes = [...dailyTotals(ofService)]
      .filter(([, cost]) => cost >= usual * SPIKE_MULTIPLE)
      .sort(([a], [b]) => a.localeCompare(b));
    const impact = spikes.reduce((n, [, cost]) => n + cost - usual, 0);
    if (impact < MIN_IMPACT_MICROS) return [];
    const dates = spikes.map(([date]) => date);
    const total = spikes.reduce((n, [, cost]) => n + cost, 0);
    const when =
      dates.length === 1
        ? `on ${dates[0]}`
        : `over ${dates.length} days (${dates[0]} to ${dates.at(-1)})`;
    return [
      finding(
        "usage-spike",
        service,
        impact,
        evidenceFor(ofService, dates),
        `${service} cost ${usd(total)} ${when}, against a usual ${usd(usual)} a day: ${usd(impact)} above usual.`
      )
    ];
  });
}

type ServiceCosts = Readonly<{
  service: string;
  records: Records;
  now: number;
  before: ReadonlyArray<number>;
  usual: number;
}>;

function newService({ service, records, now, usual }: ServiceCosts): Finding[] {
  if (usual !== 0 || now < MIN_IMPACT_MICROS) return [];
  const dates = records
    .filter((r) => (r.costMicros ?? 0) > 0)
    .map((r) => r.date)
    .sort()
    .slice(0, 1);
  return [
    finding(
      "new-service",
      service,
      now,
      evidenceFor(records, dates),
      `${service} was charged for the first time, from ${dates[0]}: ${usd(now)}.`
    )
  ];
}

function removedService({
  service,
  now,
  before,
  usual
}: ServiceCosts): Finding[] {
  const alwaysCharged = before.every((cost) => cost > 0);
  if (now !== 0 || usual < MIN_IMPACT_MICROS || !alwaysCharged) return [];
  return [
    finding(
      "removed-service",
      service,
      -usual,
      [],
      `${service} has no charges this period. It usually costs ${usd(usual)}.`
    )
  ];
}

function usageDrop({ service, records, now, usual }: ServiceCosts): Finding[] {
  const fall = usual - now;
  if (now <= 0 || now > usual * DROP_RATIO || fall < MIN_IMPACT_MICROS)
    return [];
  const lowest = [...dailyTotals(records)]
    .sort(([dateA, a], [dateB, b]) => a - b || dateA.localeCompare(dateB))
    .slice(0, LOW_DAYS_SHOWN)
    .map(([date]) => date)
    .sort();
  return [
    finding(
      "usage-drop",
      service,
      -fall,
      evidenceFor(records, lowest),
      `${service} cost ${usd(now)} this period against a usual ${usd(usual)}: ${usd(fall)} lower.`
    )
  ];
}

function detectServiceChanges(input: DetectorInput): Finding[] {
  const periods = input.baselines.map((b) => b.records);
  const services = unique(
    [...input.current, ...periods.flat()].map((r) => r.service)
  );
  return services.flatMap((service) => {
    const records = input.current.filter((r) => r.service === service);
    const before = periods.map((p) =>
      costOf(p.filter((r) => r.service === service))
    );
    const costs = {
      service,
      records,
      now: costOf(records),
      before,
      usual: mean(before)
    };
    return [
      ...newService(costs),
      ...removedService(costs),
      ...usageDrop(costs)
    ];
  });
}

function detectAllowanceExhausted(input: DetectorInput): Finding[] {
  const baseline = input.baselines.flatMap((b) => b.records);
  const keys = unique(
    input.current.map((r) => `${r.service}\u0000${r.metric}`)
  );
  return keys.flatMap((key) => {
    const matches = (r: UsageRecord) => `${r.service}\u0000${r.metric}` === key;
    const before = baseline.filter(matches);
    const wasWithinAllowance =
      before.some((r) => r.quantity > 0) &&
      before.every((r) => r.billableQuantity === 0);
    if (!wasWithinAllowance) return [];
    const billed = input.current
      .filter((r) => matches(r) && (r.billableQuantity ?? 0) > 0)
      .sort((a, b) => a.date.localeCompare(b.date));
    const impact = costOf(billed);
    if (impact < MIN_IMPACT_MICROS) return [];
    return billed
      .slice(0, 1)
      .map((first) =>
        finding(
          "quantity-step",
          first.service,
          impact,
          evidenceFor(billed, [first.date]),
          `${first.service} ${first.metric} went past the included allowance on ${first.date}; usage beyond it cost ${usd(impact)}.`
        )
      );
  });
}

function detectZoneChanges(input: DetectorInput): Finding[] {
  const periods = input.baselines.map((b) => b.records);
  const zoneCost = (records: Records, zone: string) =>
    costOf(records.filter((r) => r.zone === zone));
  const zones = unique(
    [...input.current, ...periods.flat()].flatMap((r) =>
      r.zone ? [r.zone] : []
    )
  );
  return zones.flatMap((zone) => {
    const now = zoneCost(input.current, zone);
    const before = periods.map((p) => zoneCost(p, zone));
    const seenBefore = periods.some((p) => p.some((r) => r.zone === zone));
    if (!seenBefore && now >= MIN_IMPACT_MICROS) {
      return [
        finding(
          "zone-change",
          null,
          now,
          [],
          `Zone ${zone} has charges this period and had none before: ${usd(now)}.`
        )
      ];
    }
    const usual = mean(before);
    if (now === 0 && usual >= MIN_IMPACT_MICROS && before.every((c) => c > 0)) {
      return [
        finding(
          "zone-change",
          null,
          -usual,
          [],
          `Zone ${zone} has no charges this period. It usually costs ${usd(usual)}.`
        )
      ];
    }
    return [];
  });
}

function detectPeriodLength(input: DetectorInput): Finding[] {
  const days = daysInPeriod(input.period);
  const usualDays = mean(input.baselines.map((b) => daysInPeriod(b.period)));
  const difference = days - usualDays;
  if (Math.abs(difference) < 1) return [];
  const usualDaily =
    mean(input.baselines.map((b) => costOf(b.records))) / usualDays;
  const impact = usualDaily * difference;
  if (Math.abs(impact) < MIN_IMPACT_MICROS) return [];
  const usualText = Number.isInteger(usualDays)
    ? String(usualDays)
    : usualDays.toFixed(1);
  return [
    finding(
      "period-length",
      null,
      impact,
      [],
      `This period has ${days} days against a usual ${usualText}. At the usual ${usd(usualDaily)} a day that is ${usd(Math.abs(impact))} ${impact < 0 ? "lower" : "higher"}.`
    )
  ];
}

function detectInvoiceVariance(input: DetectorInput): Finding[] {
  const usage = micros(costOf(input.current));
  const result = reconcile(usage, input.invoiceMicros);
  if (result.status !== "variance" || input.invoiceMicros === null) return [];
  return [
    finding(
      "invoice-variance",
      null,
      result.varianceMicros,
      [],
      `The invoice is ${formatUsd(input.invoiceMicros)} and the usage for the period adds up to ${formatUsd(usage)}: a difference of ${usd(Math.abs(result.varianceMicros))}.`
    )
  ];
}

/** The change in each service that service-level findings do not account for. */
function unexplained(
  deltaMicros: Micros,
  services: ReadonlyArray<ServiceDelta>,
  findings: ReadonlyArray<Finding>
): Micros {
  const explained = services.reduce((total, service) => {
    const claimed = findings
      .filter(
        (f) => f.service === service.service && SERVICE_LEVEL.has(f.detector)
      )
      .reduce((n, f) => n + f.impactMicros, 0);
    // A finding can never explain more than the service actually changed.
    const delta = service.deltaMicros;
    const capped =
      delta >= 0
        ? Math.min(Math.max(claimed, 0), delta)
        : Math.max(Math.min(claimed, 0), delta);
    return total + capped;
  }, 0);
  return micros(deltaMicros - explained);
}

/** Runs every detector. Findings are ordered by the size of their impact. */
export function runDetectors(input: DetectorInput): DetectorResult {
  const comparison = compareToBaseline(
    input.current,
    input.baselines.map((b) => b.records)
  );
  const compared = comparison.comparable
    ? [
        ...detectSpikes(input),
        ...detectServiceChanges(input),
        ...detectAllowanceExhausted(input),
        ...detectZoneChanges(input),
        ...detectPeriodLength(input)
      ]
    : [];
  const findings = [...compared, ...detectInvoiceVariance(input)].sort(
    (a, b) =>
      Math.abs(b.impactMicros) - Math.abs(a.impactMicros) ||
      a.detector.localeCompare(b.detector)
  );
  return {
    findings,
    unexplainedMicros: comparison.comparable
      ? unexplained(comparison.deltaMicros, comparison.services, findings)
      : null
  };
}

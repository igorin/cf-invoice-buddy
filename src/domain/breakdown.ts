import { micros, percentChange, type Micros } from "./money";
import type { IsoDate } from "./periods";
import type { UsageRecord } from "./usage";

/**
 * Fewer prior periods than this and no baseline is offered (spec section 5).
 * A single month is enough only when the owner named it.
 */
export const MIN_BASELINE_PERIODS = 2;

export type CostTotal = Readonly<{
  costMicros: Micros;
  /** Records the source gave no cost for. They are not counted as zero. */
  uncostedRecords: number;
}>;

export type ServiceTotal = CostTotal & Readonly<{ service: string }>;

export type DailyCost = Readonly<{ date: IsoDate; costMicros: Micros }>;

export type ServiceDelta = Readonly<{
  service: string;
  currentMicros: Micros;
  baselineMicros: Micros;
  deltaMicros: Micros;
}>;

export type Comparison =
  | Readonly<{
      comparable: false;
      reason: "insufficient_history";
      totalMicros: Micros;
    }>
  | Readonly<{
      comparable: true;
      totalMicros: Micros;
      baselineMicros: Micros;
      deltaMicros: Micros;
      percent: number | null;
      services: ReadonlyArray<ServiceDelta>;
    }>;

function sumBy<K>(
  records: ReadonlyArray<UsageRecord>,
  keyOf: (record: UsageRecord) => K
): Map<K, number> {
  const sums = new Map<K, number>();
  for (const record of records) {
    const key = keyOf(record);
    sums.set(key, (sums.get(key) ?? 0) + (record.costMicros ?? 0));
  }
  return sums;
}

export function totalCost(records: ReadonlyArray<UsageRecord>): CostTotal {
  return {
    costMicros: micros(records.reduce((n, r) => n + (r.costMicros ?? 0), 0)),
    uncostedRecords: records.filter((r) => r.costMicros === null).length
  };
}

/** Cost per service, largest first; equal costs are ordered by name. */
export function totalsByService(
  records: ReadonlyArray<UsageRecord>
): ReadonlyArray<ServiceTotal> {
  const services = [...new Set(records.map((record) => record.service))];
  return services
    .map((service) => ({
      service,
      ...totalCost(records.filter((record) => record.service === service))
    }))
    .sort(
      (a, b) =>
        b.costMicros - a.costMicros || a.service.localeCompare(b.service)
    );
}

/** Cost per day for one service, in date order. */
export function dailyCost(
  records: ReadonlyArray<UsageRecord>,
  service: string
): ReadonlyArray<DailyCost> {
  const ofService = records.filter((record) => record.service === service);
  return [...sumBy(ofService, (record) => record.date)]
    .map(([date, cost]) => ({ date, costMicros: micros(cost) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Compares a period with the mean of the baseline periods, per service.
 * Each service's baseline is rounded once and the total baseline is the sum
 * of those, so the service deltas always add up to the total delta.
 */
export function compareToBaseline(
  current: ReadonlyArray<UsageRecord>,
  baselines: ReadonlyArray<ReadonlyArray<UsageRecord>>,
  minPeriods: number = MIN_BASELINE_PERIODS
): Comparison {
  const totalMicros = totalCost(current).costMicros;
  if (baselines.length < minPeriods) {
    return { comparable: false, reason: "insufficient_history", totalMicros };
  }

  const currentByService = sumBy(current, (record) => record.service);
  const baselineByService = sumBy(baselines.flat(), (record) => record.service);
  const names = new Set([
    ...currentByService.keys(),
    ...baselineByService.keys()
  ]);

  const services = [...names]
    .map((service) => {
      const currentMicros = micros(currentByService.get(service) ?? 0);
      const baselineMicros = micros(
        Math.round((baselineByService.get(service) ?? 0) / baselines.length)
      );
      return {
        service,
        currentMicros,
        baselineMicros,
        deltaMicros: micros(currentMicros - baselineMicros)
      };
    })
    .sort(
      (a, b) =>
        Math.abs(b.deltaMicros) - Math.abs(a.deltaMicros) ||
        a.service.localeCompare(b.service)
    );

  const baselineMicros = micros(
    services.reduce((n, service) => n + service.baselineMicros, 0)
  );
  return {
    comparable: true,
    totalMicros,
    baselineMicros,
    deltaMicros: micros(totalMicros - baselineMicros),
    percent: percentChange(baselineMicros, totalMicros),
    services
  };
}

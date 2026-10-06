import type { ServiceDelta } from "./breakdown";
import type { DetectorId, Finding } from "./findings";
import { micros, type Micros } from "./money";

// The detectors whose impacts are counted against a service's change.
const SERVICE_LEVEL: ReadonlySet<DetectorId> = new Set([
  "usage-spike",
  "usage-drop",
  "new-service",
  "removed-service"
]);

/** Brings an explained amount to within the change it is explaining. */
function capTo(delta: number, claimed: number): number {
  return delta >= 0
    ? Math.min(Math.max(claimed, 0), delta)
    : Math.max(Math.min(claimed, 0), delta);
}

/**
 * The part of the total change that no finding accounts for.
 *
 * Service findings (spike, drop, new, removed) are counted per service, each
 * capped at that service's change. Zone findings describe the same dollars
 * from another angle, so they are not added on top: whichever view explains
 * more of the change is used.
 */
export function unexplained(
  deltaMicros: Micros,
  services: ReadonlyArray<ServiceDelta>,
  findings: ReadonlyArray<Finding>
): Micros {
  const byService = services.reduce((total, service) => {
    const claimed = findings
      .filter(
        (f) => f.service === service.service && SERVICE_LEVEL.has(f.detector)
      )
      .reduce((n, f) => n + f.impactMicros, 0);
    return total + capTo(service.deltaMicros, claimed);
  }, 0);
  const byZone = capTo(
    deltaMicros,
    findings
      .filter((f) => f.detector === "zone-change")
      .reduce((n, f) => n + f.impactMicros, 0)
  );
  const explained = Math.abs(byZone) > Math.abs(byService) ? byZone : byService;
  return micros(deltaMicros - explained);
}

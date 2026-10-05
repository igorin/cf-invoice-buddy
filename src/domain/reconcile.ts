import { micros, type Micros } from "./money";

/** An invoice within this of the summed usage counts as matching. */
const TOLERANCE_MICROS = 1_000_000;
const TOLERANCE_RATIO = 0.01;

export type Reconciliation =
  | Readonly<{ status: "no_invoice" }>
  | Readonly<{ status: "matched" | "variance"; varianceMicros: Micros }>;

/**
 * Compares the summed usage for a period with its issued invoice (UC-6).
 * The variance is the invoice minus the usage.
 */
export function reconcile(
  usageMicros: Micros,
  invoiceMicros: Micros | null
): Reconciliation {
  if (invoiceMicros === null) return { status: "no_invoice" };
  const varianceMicros = micros(invoiceMicros - usageMicros);
  const tolerance = Math.max(
    TOLERANCE_MICROS,
    Math.abs(invoiceMicros) * TOLERANCE_RATIO
  );
  return {
    status: Math.abs(varianceMicros) > tolerance ? "variance" : "matched",
    varianceMicros
  };
}

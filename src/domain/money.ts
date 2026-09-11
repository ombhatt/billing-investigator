import {
  cents,
  quantity as asQuantity,
  sumCents as sumCheckedCents,
  type Cents,
  type Quantity
} from "./units.js";

/**
 * All money is integer cents. Binary floating point is never used for a
 * currency value. PRD §12.1.
 *
 * Rounding order for the MVP (PRD §12.2): each service's monthly rated charge
 * is rounded to the nearest cent, half up, and only then are invoice lines
 * summed. No rounding happens after summation.
 */

/**
 * Cost of `quantity` units at a rate of `ratePerUnitCents` per `unitDivisor`
 * units, rounded half up.
 *
 * BigInt keeps the intermediate product exact: billable quantities reach
 * 1.48e9 and rates are in cents, so the product can exceed what is comfortable
 * to reason about in a double even when it stays under Number.MAX_SAFE_INTEGER.
 */
export function rateCents(
  quantity: Quantity | number,
  ratePerUnitCents: Cents | number,
  unitDivisor: number
): Cents {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError(`quantity must be a non-negative integer: ${quantity}`);
  }
  if (!Number.isInteger(ratePerUnitCents) || ratePerUnitCents < 0) {
    throw new RangeError(`rate must be a non-negative integer: ${ratePerUnitCents}`);
  }
  if (!Number.isInteger(unitDivisor) || unitDivisor <= 0) {
    throw new RangeError(`unitDivisor must be a positive integer: ${unitDivisor}`);
  }

  const numerator = BigInt(quantity) * BigInt(ratePerUnitCents);
  const denominator = BigInt(unitDivisor);
  // floor(n/d + 1/2) without leaving integer arithmetic.
  const rated = (2n * numerator + denominator) / (2n * denominator);

  return cents(Number(rated), "rated charge");
}

/**
 * Percentage change as a number, or null when the comparison base is zero.
 * PRD §12.4 requires the zero case to be explicit rather than Infinity or NaN.
 */
export function percentageChange(
  currentCents: Cents,
  comparisonCents: Cents
): number | null {
  if (comparisonCents === 0) return null;
  return ((currentCents - comparisonCents) / comparisonCents) * 100;
}

/** One-decimal display rounding, half up. 28.52071 -> 28.5 */
export function toOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Presentation boundary only. Never feed this back into a calculation. */
export function formatUsd(amount: Cents | number): string {
  const sign = amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  const dollars = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(remainder).padStart(2, "0")}`;
}

/**
 * Sum of validated cents, re-exported so callers have one place to reach for.
 *
 * This used to be a bare `reduce` with no checks at all, two functions below a
 * `rateCents` that validated every input and its result. A total that leaves
 * the exactly-representable range is wrong by an unpredictable amount, and a
 * total wrong by a cent is the one thing reconciliation exists to catch.
 */
export function sumCents(values: readonly Cents[], what = "total"): Cents {
  return sumCheckedCents(values, what);
}

/** Marks a literal as cents at a call site that has already reasoned about it. */
export { cents, asQuantity as quantity };

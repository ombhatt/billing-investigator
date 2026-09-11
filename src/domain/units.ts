/**
 * Validated domain values.
 *
 * `type Period = string` and `amountCents: number` named an invariant without
 * enforcing one: any string was a period, any number was money, and `sumCents`
 * added values it had never checked while `rateCents` two functions above
 * validated everything it touched. An interface that says "cents" should not
 * accept 12.5, and one that says "period" should not accept "banana".
 *
 * Brands rather than classes: these are numbers and strings at runtime, so they
 * cross the D1 and JSON boundaries unchanged and cost nothing to carry. What
 * they buy is that the only way to *produce* one is a constructor that checked
 * it, and the only way to combine them is an operation that checked the result.
 *
 * Arithmetic on a branded number yields a plain number, which then will not
 * assign back. That is the point, not an inconvenience: it routes every sum
 * through a function that can notice an overflow.
 */

declare const CENTS: unique symbol;
declare const QUANTITY: unique symbol;
declare const PERIOD: unique symbol;
declare const DATE: unique symbol;

/** An integer number of cents. May be negative: credits and falls are real. */
export type Cents = number & { readonly [CENTS]: true };

/** A non-negative integer count of billable units. */
export type Quantity = number & { readonly [QUANTITY]: true };

/** A billing month, `YYYY-MM`. */
export type BillingPeriod = string & { readonly [PERIOD]: true };

/** A calendar day, `YYYY-MM-DD`. */
export type IsoDate = string & { readonly [DATE]: true };

export class InvalidValue extends RangeError {}

function reject(what: string, value: unknown, why: string): never {
  throw new InvalidValue(`${what} ${why}: ${String(value)}`);
}

export function cents(value: number, what = "cents"): Cents {
  if (typeof value !== "number" || Number.isNaN(value)) {
    reject(what, value, "must be a number");
  }
  if (!Number.isInteger(value)) {
    // The whole point of integer cents is that 0.1 + 0.2 never happens here.
    reject(what, value, "must be a whole number of cents");
  }
  if (!Number.isSafeInteger(value)) {
    reject(what, value, "exceeds the safe integer range");
  }
  return value as Cents;
}

export function quantity(value: number, what = "quantity"): Quantity {
  if (typeof value !== "number" || Number.isNaN(value)) {
    reject(what, value, "must be a number");
  }
  if (!Number.isInteger(value)) reject(what, value, "must be a whole number");
  if (!Number.isSafeInteger(value)) {
    reject(what, value, "exceeds the safe integer range");
  }
  if (value < 0) reject(what, value, "must not be negative");
  return value as Quantity;
}

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export function billingPeriod(value: string, what = "period"): BillingPeriod {
  if (typeof value !== "string" || !PERIOD_PATTERN.test(value)) {
    reject(what, value, "must be a month in YYYY-MM form");
  }
  return value as BillingPeriod;
}

export function isoDate(value: string, what = "date"): IsoDate {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
    reject(what, value, "must be a date in YYYY-MM-DD form");
  }
  // Catches 2026-02-31, which the pattern alone admits.
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    reject(what, value, "is not a real calendar date");
  }
  return value as IsoDate;
}

// --- Checked arithmetic ----------------------------------------------------

/**
 * Adds cents, refusing a total that leaves the exactly-representable range.
 *
 * Checked cumulatively rather than only at the end: two values that each fit
 * can produce a sum that silently loses precision, and a total that is wrong by
 * a cent is the one thing reconciliation exists to catch.
 */
export function sumCents(values: readonly Cents[], what = "total"): Cents {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      reject(what, total, "overflows the safe integer range");
    }
  }
  return total as Cents;
}

export function addCents(a: Cents, b: Cents, what = "total"): Cents {
  return sumCents([a, b], what);
}

export function subtractCents(a: Cents, b: Cents, what = "difference"): Cents {
  const result = a - b;
  if (!Number.isSafeInteger(result)) {
    reject(what, result, "overflows the safe integer range");
  }
  return result as Cents;
}

export function absCents(value: Cents): Cents {
  return Math.abs(value) as Cents;
}

export function sumQuantities(
  values: readonly Quantity[],
  what = "quantity"
): Quantity {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      reject(what, total, "overflows the safe integer range");
    }
  }
  return total as Quantity;
}

// --- Compatibility ---------------------------------------------------------

/**
 * Refuses to combine amounts denominated differently.
 *
 * Nothing in the seeded data mixes currencies, which is exactly why this is
 * worth stating: the absence of a second currency is a property of the fixture,
 * not of the code, and the code should say so rather than rely on it.
 */
export function assertSameCurrency(
  currencies: readonly string[],
  what = "amounts"
): string {
  const distinct = [...new Set(currencies)];
  if (distinct.length > 1) {
    throw new InvalidValue(
      `cannot combine ${what} in different currencies: ${distinct.sort().join(", ")}`
    );
  }
  return distinct[0] ?? "USD";
}

/** The same, for usage: requests and neurons do not add. */
export function assertSameUnit(units: readonly string[], what = "quantities"): string {
  const distinct = [...new Set(units)];
  if (distinct.length > 1) {
    throw new InvalidValue(
      `cannot combine ${what} in different units: ${distinct.sort().join(", ")}`
    );
  }
  return distinct[0] ?? "";
}

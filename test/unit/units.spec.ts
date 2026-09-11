import { describe, expect, it } from "vitest";
import {
  addCents,
  assertSameCurrency,
  assertSameUnit,
  billingPeriod,
  cents,
  InvalidValue,
  isoDate,
  quantity,
  subtractCents,
  sumCents,
  sumQuantities
} from "../../src/domain/units.js";

/**
 * The invariants the type names were only claiming.
 *
 * `type Period = string` accepted any string. `amountCents: number` accepted
 * 12.5. And `sumCents` was a bare `reduce` sitting two functions below a
 * `rateCents` that validated every input and its result — the same file
 * disagreeing with itself about whether money needed checking.
 */

describe("cents", () => {
  it("accepts whole amounts, including negative ones", () => {
    // Credits and falls are real: a negative amount is not an invalid one.
    expect(cents(0)).toBe(0);
    expect(cents(2_172_000)).toBe(2_172_000);
    expect(cents(-482_000)).toBe(-482_000);
  });

  it("rejects a fractional cent", () => {
    // The entire point of integer cents is that 0.1 + 0.2 never happens here.
    expect(() => cents(12.5)).toThrow(InvalidValue);
    expect(() => cents(0.1 + 0.2)).toThrow(/whole number of cents/);
  });

  it("rejects values outside the exactly-representable range", () => {
    expect(() => cents(Number.MAX_SAFE_INTEGER + 2)).toThrow(/safe integer/);
    expect(() => cents(Infinity)).toThrow(InvalidValue);
    expect(() => cents(Number.NaN)).toThrow(/must be a number/);
  });

  it("names what was wrong, so the error points at the row", () => {
    expect(() => cents(1.5, "invoice inv-abc123-2026-08 total")).toThrow(
      /invoice inv-abc123-2026-08 total/
    );
  });
});

describe("quantity", () => {
  it("accepts whole non-negative counts", () => {
    expect(quantity(0)).toBe(0);
    expect(quantity(1_580_000_000)).toBe(1_580_000_000);
  });

  it("rejects fractions and negatives", () => {
    // Unlike money, a negative count of requests is not a thing that happened.
    expect(() => quantity(1.5)).toThrow(/whole number/);
    expect(() => quantity(-1)).toThrow(/must not be negative/);
  });
});

describe("periods and dates", () => {
  it("accepts real months and days", () => {
    expect(billingPeriod("2026-08")).toBe("2026-08");
    expect(isoDate("2026-08-14")).toBe("2026-08-14");
  });

  it("rejects anything that is not a month", () => {
    for (const bad of ["banana", "2026-13", "2026-00", "2026", "2026-8", ""]) {
      expect(() => billingPeriod(bad), bad).toThrow(InvalidValue);
    }
  });

  it("rejects a date that looks right and never happened", () => {
    // The pattern admits 2026-02-31; the calendar does not.
    expect(() => isoDate("2026-02-31")).toThrow(/not a real calendar date/);
    expect(() => isoDate("2026-04-31")).toThrow(/not a real calendar date/);
    expect(isoDate("2024-02-29")).toBe("2024-02-29"); // a real leap day
    expect(() => isoDate("2026-02-29")).toThrow(/not a real calendar date/);
  });

  it("rejects a month where a day belongs, and the reverse", () => {
    expect(() => billingPeriod("2026-08-14")).toThrow(InvalidValue);
    expect(() => isoDate("2026-08")).toThrow(InvalidValue);
  });
});

describe("checked arithmetic", () => {
  it("adds and subtracts", () => {
    expect(sumCents([cents(100), cents(250), cents(-50)])).toBe(300);
    expect(addCents(cents(1), cents(2))).toBe(3);
    expect(subtractCents(cents(10), cents(4))).toBe(6);
    expect(sumCents([])).toBe(0);
  });

  it("refuses a total that would leave the exact range", () => {
    // Each value fits; the total does not. Checked cumulatively rather than
    // only at the end, because a sum that silently loses precision is wrong by
    // an unpredictable amount — and a total wrong by a cent is the one thing
    // reconciliation exists to catch.
    const big = cents(Number.MAX_SAFE_INTEGER - 10);
    expect(() => sumCents([big, cents(100)])).toThrow(/overflows/);
    expect(() => addCents(big, big)).toThrow(/overflows/);
  });

  it("refuses an overflowing difference", () => {
    const big = cents(Number.MAX_SAFE_INTEGER - 10);
    expect(() => subtractCents(cents(-100), big)).toThrow(/overflows/);
  });

  it("applies the same rule to quantities", () => {
    expect(sumQuantities([quantity(1), quantity(2)])).toBe(3);
    expect(() =>
      sumQuantities([quantity(Number.MAX_SAFE_INTEGER - 1), quantity(100)])
    ).toThrow(/overflows/);
  });
});

describe("compatibility", () => {
  it("combines amounts in one currency", () => {
    expect(assertSameCurrency(["USD", "USD"])).toBe("USD");
    expect(assertSameCurrency([])).toBe("USD");
  });

  it("refuses to combine amounts in different currencies", () => {
    // Nothing in the seeded data mixes currencies, which is exactly why this
    // matters: that is a property of the fixture, not of the code.
    expect(() => assertSameCurrency(["USD", "EUR"], "invoice lines")).toThrow(
      /different currencies: EUR, USD/
    );
  });

  it("refuses to add requests to neurons", () => {
    expect(assertSameUnit(["requests", "requests"])).toBe("requests");
    expect(() => assertSameUnit(["requests", "units"], "Workers usage")).toThrow(
      /Workers usage in different units: requests, units/
    );
  });
});

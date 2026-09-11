import { c } from "./../support/values.js";
import { describe, expect, it } from "vitest";
import {
  formatUsd,
  percentageChange,
  rateCents,
  sumCents,
  toOneDecimal
} from "../../src/domain/money.js";

describe("integer-cent currency behaviour", () => {
  it("rates whole millions exactly", () => {
    // 900M requests at $8.00 per million = $7,200.00
    expect(rateCents(900_000_000, 800, 1_000_000)).toBe(720_000);
    // 1.48B requests at $8.00 per million = $11,840.00
    expect(rateCents(1_480_000_000, 800, 1_000_000)).toBe(1_184_000);
  });

  it("rounds half up at the cent", () => {
    // 1.5 cents rounds to 2, not down and not to even.
    expect(rateCents(15, 1, 10)).toBe(2);
    expect(rateCents(25, 1, 10)).toBe(3);
    // 1.4 cents rounds to 1.
    expect(rateCents(14, 1, 10)).toBe(1);
  });

  it("stays exact where floating point would not", () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; cents have no such problem.
    expect(sumCents([10, 20].map((n) => c(n)))).toBe(30);
    // A quantity large enough that a double would start losing precision if
    // the product were computed naively.
    expect(rateCents(1_580_000_000, 5000, 1_000_000)).toBe(7_900_000);
  });

  it("rejects non-integer and negative inputs rather than coercing", () => {
    expect(() => rateCents(1.5, 800, 1_000_000)).toThrow(RangeError);
    expect(() => rateCents(-1, 800, 1_000_000)).toThrow(RangeError);
    expect(() => rateCents(10, 800, 0)).toThrow(RangeError);
  });

  it("returns null instead of dividing by a zero comparison total", () => {
    expect(percentageChange(c(1000), c(0))).toBeNull();
    expect(Number.isFinite(percentageChange(c(1000), c(500)) as number)).toBe(true);
  });

  it("computes the golden percentage and its display rounding", () => {
    const pct = percentageChange(c(2_172_000), c(1_690_000)) as number;
    expect(pct).toBeCloseTo(28.52071, 5);
    expect(toOneDecimal(pct)).toBe(28.5);
  });

  it("formats only at the presentation boundary", () => {
    expect(formatUsd(2_172_000)).toBe("$21,720.00");
    expect(formatUsd(1_690_000)).toBe("$16,900.00");
    expect(formatUsd(482_000)).toBe("$4,820.00");
    expect(formatUsd(-505)).toBe("-$5.05");
    expect(formatUsd(7)).toBe("$0.07");
  });
});

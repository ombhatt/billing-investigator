import { describe, expect, it } from "vitest";
import { periodsMentioned } from "../../src/domain/period.js";

/**
 * Which months a piece of text is talking about.
 *
 * Two callers depend on this and both learned it the hard way: a question
 * naming a month the account does not have must be challenged rather than
 * quietly answered about another month, and prose naming a month that was never
 * investigated is a false claim even when every figure in it is real.
 */
describe("periodsMentioned", () => {
  it("reads month names with a year", () => {
    expect(periodsMentioned("Why did May 2026 jump against April 2026?")).toEqual([
      "2026-04",
      "2026-05"
    ]);
  });

  it("is case-insensitive and handles every month", () => {
    expect(periodsMentioned("JANUARY 2026")).toEqual(["2026-01"]);
    expect(periodsMentioned("december 2025")).toEqual(["2025-12"]);
    expect(periodsMentioned("Sept")).toEqual([]);
    expect(periodsMentioned("September 2026")).toEqual(["2026-09"]);
  });

  it("reads bare YYYY-MM", () => {
    expect(periodsMentioned("compare 2026-08 with 2026-07")).toEqual([
      "2026-07",
      "2026-08"
    ]);
  });

  it("does not read a full date as a period", () => {
    // 2026-08-14 is a change point, not an invoice month. Reading it as one
    // would flag the golden narrative on every run.
    expect(periodsMentioned("Usage shifted on 2026-08-14.")).toEqual([]);
    expect(periodsMentioned("between 2026-07-01 and 2026-08-31")).toEqual([]);
  });

  it("does not read the word 'may' as a month", () => {
    expect(periodsMentioned("this may indicate a change")).toEqual([]);
    expect(periodsMentioned("usage may rise")).toEqual([]);
    // Only with a year beside it.
    expect(periodsMentioned("usage may rise in May 2026")).toEqual(["2026-05"]);
  });

  it("rejects an impossible month number", () => {
    expect(periodsMentioned("2026-13")).toEqual([]);
    expect(periodsMentioned("2026-00")).toEqual([]);
  });

  it("deduplicates and sorts", () => {
    expect(
      periodsMentioned("August 2026 and 2026-08 and August 2026 and July 2026")
    ).toEqual(["2026-07", "2026-08"]);
  });

  it("finds nothing in text that names no month", () => {
    expect(periodsMentioned("why is my bill higher?")).toEqual([]);
    expect(periodsMentioned("")).toEqual([]);
  });
});

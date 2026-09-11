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

describe("a bare month, resolved against a known year", () => {
  it("reads a month named without a year when the year is supplied", () => {
    // The user's exact wording. Without a year assumption this found nothing,
    // so a follow-up about June was never recognised as out of scope.
    expect(
      periodsMentioned("what about their billing for the month of June?", 2026)
    ).toEqual(["2026-06"]);
  });

  it("ignores bare months when no year is supplied", () => {
    expect(periodsMentioned("what about the month of June?")).toEqual([]);
  });

  /**
   * "may" was excluded from bare-month matching outright, which was the safe
   * half of one trade-off and the unsafe half of another: it also meant "the
   * May invoice jumped" was invisible, both when a reader asked it and when the
   * model wrote it over a different month's figures.
   *
   * What separates the two senses is the company the word keeps.
   */
  it("reads 'may' as a month when it sits against a billing noun", () => {
    for (const text of [
      "why did the May invoice jump?",
      "May charges were higher",
      "the charges for May",
      "billing for the month of May",
      "May's invoice total"
    ]) {
      expect(periodsMentioned(text, 2026)).toContain("2026-05");
    }
  });

  it("reads 'may' as a verb everywhere else", () => {
    for (const text of [
      "this may indicate a deployment change",
      "usage may have risen",
      "we may bill you separately for overages",
      "the invoice may be correct",
      "charges may not reflect the new contract",
      "that may well explain the variance"
    ]) {
      expect(periodsMentioned(text, 2026)).toEqual([]);
    }
  });

  it("still finds May when the year is explicit", () => {
    expect(periodsMentioned("what about May 2026?", 2026)).toEqual(["2026-05"]);
    // And with no year to assume, a bare month stays out.
    expect(periodsMentioned("why did the May invoice jump?")).toEqual([]);
  });

  it("prefers an explicit year over the assumed one", () => {
    expect(periodsMentioned("June 2025 versus July", 2026).sort()).toEqual([
      "2025-06",
      "2026-06",
      "2026-07"
    ]);
  });

  it("still ignores a day inside a full date", () => {
    expect(periodsMentioned("usage shifted on 2026-08-14", 2026)).toEqual([]);
  });
});

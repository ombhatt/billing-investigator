import { billingPeriod, isoDate } from "./units.js";
import type { IsoDate, Period } from "./types.js";

/** Kept for its name; the validation now lives with the type it produces. */
export function assertPeriod(period: string): Period {
  return billingPeriod(period);
}

export function periodStart(period: Period): IsoDate {
  return isoDate(`${assertPeriod(period)}-01`);
}

export function daysInPeriod(period: Period): number {
  const [year, month] = assertPeriod(period).split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function periodEnd(period: Period): IsoDate {
  return isoDate(`${period}-${String(daysInPeriod(period)).padStart(2, "0")}`);
}

/** Every date in the period, ascending. */
export function periodDates(period: Period): IsoDate[] {
  const count = daysInPeriod(period);
  const dates: IsoDate[] = [];
  for (let day = 1; day <= count; day++) {
    dates.push(isoDate(`${period}-${String(day).padStart(2, "0")}`));
  }
  return dates;
}

export function periodOf(date: IsoDate): Period {
  return billingPeriod(date.slice(0, 7));
}

/** 0 = Sunday. Computed in UTC so it never depends on the host timezone. */
export function dayOfWeek(date: IsoDate): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const day = dayOfWeek(date);
  return day === 0 || day === 6;
}

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

/**
 * A month named in prose, as `YYYY-MM`. Requires a year beside the month, so
 * "may indicate" is not read as a period while "May 2026" is.
 */
const NAMED_MONTH = new RegExp(
  `\\b(${MONTH_NAMES.join("|")})\\s+(\\d{4})\\b`,
  "gi"
);

/** A bare `YYYY-MM`, excluding the leading half of a full `YYYY-MM-DD`. */
const BARE_PERIOD = /\b\d{4}-(?:0[1-9]|1[0-2])\b(?!-\d)/g;

/**
 * A month named with no year — "billing for the month of June".
 *
 * "may" is deliberately absent: it is a common verb, and reading "this may
 * indicate" as a period would be worse than missing a genuine "may". It is
 * still recognised when a year sits beside it, via NAMED_MONTH above.
 */
const BARE_MONTH = new RegExp(
  `\\b(${MONTH_NAMES.filter((m) => m !== "may").join("|")})\\b`,
  "gi"
);

/**
 * Every billing period a piece of text refers to, however it spells them.
 *
 * Used in two places that both learned the same lesson: a question naming a
 * month the account does not have must be challenged rather than quietly
 * answered about a different month, and prose naming a month that was never
 * investigated is a fabricated claim even though no digit is wrong.
 */
export function periodsMentioned(
  text: string,
  /**
   * Year to assume for a month named without one. Supply it only where the
   * context makes the year unambiguous — a follow-up to an investigation of
   * known periods. Omitted, a bare month is ignored rather than guessed.
   */
  assumeYear?: number
): Period[] {
  const found = new Set<Period>();
  // Constructed rather than asserted: a month index out of range would be
  // caught here rather than travelling as a period-shaped string.
  const asPeriod = (year: string | number, month: number) =>
    billingPeriod(`${year}-${String(month).padStart(2, "0")}`);

  for (const match of text.matchAll(NAMED_MONTH)) {
    found.add(asPeriod(match[2], MONTH_NAMES.indexOf(match[1].toLowerCase()) + 1));
  }
  for (const match of text.match(BARE_PERIOD) ?? []) {
    found.add(billingPeriod(match));
  }
  if (assumeYear !== undefined) {
    for (const match of text.matchAll(BARE_MONTH)) {
      found.add(
        asPeriod(assumeYear, MONTH_NAMES.indexOf(match[1].toLowerCase()) + 1)
      );
    }
  }

  return [...found].sort();
}

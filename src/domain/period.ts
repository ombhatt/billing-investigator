import type { IsoDate, Period } from "./types.js";

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertPeriod(period: string): Period {
  if (!PERIOD_PATTERN.test(period)) {
    throw new RangeError(`invalid period, expected YYYY-MM: ${period}`);
  }
  return period;
}

export function periodStart(period: Period): IsoDate {
  return `${assertPeriod(period)}-01`;
}

export function daysInPeriod(period: Period): number {
  const [year, month] = assertPeriod(period).split("-").map(Number);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function periodEnd(period: Period): IsoDate {
  return `${period}-${String(daysInPeriod(period)).padStart(2, "0")}`;
}

/** Every date in the period, ascending. */
export function periodDates(period: Period): IsoDate[] {
  const count = daysInPeriod(period);
  const dates: IsoDate[] = [];
  for (let day = 1; day <= count; day++) {
    dates.push(`${period}-${String(day).padStart(2, "0")}`);
  }
  return dates;
}

export function periodOf(date: IsoDate): Period {
  return date.slice(0, 7);
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
 * Every billing period a piece of text refers to, however it spells them.
 *
 * Used in two places that both learned the same lesson: a question naming a
 * month the account does not have must be challenged rather than quietly
 * answered about a different month, and prose naming a month that was never
 * investigated is a fabricated claim even though no digit is wrong.
 */
export function periodsMentioned(text: string): Period[] {
  const found = new Set<Period>();

  for (const match of text.matchAll(NAMED_MONTH)) {
    const month = MONTH_NAMES.indexOf(match[1].toLowerCase()) + 1;
    found.add(`${match[2]}-${String(month).padStart(2, "0")}`);
  }
  for (const match of text.match(BARE_PERIOD) ?? []) {
    found.add(match);
  }

  return [...found].sort();
}

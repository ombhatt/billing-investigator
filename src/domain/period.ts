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

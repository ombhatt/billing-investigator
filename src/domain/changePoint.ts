import { rateCents } from "./money.js";
import type { IsoDate, PriceVersion } from "./types.js";

export const MIN_DATA_POINTS = 14;
export const PRE_WINDOW_DAYS = 7;
export const POST_WINDOW_DAYS = 5;
export const MATERIAL_RATIO = 1.5;
export const MATERIAL_COST_IMPACT_CENTS = 10_000; // $100

export const CHANGE_POINT_METHOD =
  `median pre/post window scan; pre=${PRE_WINDOW_DAYS}d, post=${POST_WINDOW_DAYS}d, ` +
  `material at ratio >= ${MATERIAL_RATIO}x and projected impact >= $100`;

export interface DailyPoint {
  date: IsoDate;
  quantity: number;
}

export interface ChangePointResult {
  detected: boolean;
  changeDate: IsoDate | null;
  baselineDailyQuantity: number;
  postChangeDailyQuantity: number;
  ratio: number | null;
  material: boolean;
  projectedCostImpactCents: number;
  confidence: "high" | "medium" | "low";
  method: string;
  preWindow: { from: IsoDate; to: IsoDate } | null;
  postWindow: { from: IsoDate; to: IsoDate } | null;
  pointsEvaluated: number;
  reason?: string;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function emptyResult(
  pointsEvaluated: number,
  reason: string
): ChangePointResult {
  return {
    detected: false,
    changeDate: null,
    baselineDailyQuantity: 0,
    postChangeDailyQuantity: 0,
    ratio: null,
    material: false,
    projectedCostImpactCents: 0,
    confidence: "low",
    method: CHANGE_POINT_METHOD,
    preWindow: null,
    postWindow: null,
    pointsEvaluated,
    reason
  };
}

/**
 * PRD §12.7. Transparent and deterministic: for every candidate day with a full
 * pre and post window, compare the medians of those windows and keep the
 * largest sustained absolute percentage change.
 *
 * Medians rather than means so a single spike cannot move the answer, and a
 * 7-day pre-window so the weekday/weekend cycle cancels out.
 */
export function detectChangePoint(
  points: DailyPoint[],
  price?: PriceVersion
): ChangePointResult {
  const series = [...points].sort((a, b) => a.date.localeCompare(b.date));

  if (series.length < MIN_DATA_POINTS) {
    return emptyResult(
      series.length,
      `need at least ${MIN_DATA_POINTS} daily points, received ${series.length}`
    );
  }

  interface Candidate {
    index: number;
    pre: number;
    post: number;
    change: number;
    onset: boolean;
  }

  const candidates: Candidate[] = [];

  for (
    let index = PRE_WINDOW_DAYS;
    index <= series.length - POST_WINDOW_DAYS;
    index++
  ) {
    const pre = median(
      series.slice(index - PRE_WINDOW_DAYS, index).map((p) => p.quantity)
    );
    const post = median(
      series.slice(index, index + POST_WINDOW_DAYS).map((p) => p.quantity)
    );
    if (pre === 0) continue;

    // A five-day post-window still reads as "shifted" when it contains only
    // three shifted days, so the window medians alone tie across several
    // adjacent dates and the winner would come down to noise. Requiring the
    // candidate day to be in the new regime while the day before it is not
    // picks the onset, which is the date the question is actually asking for.
    const regimeThreshold = pre * MATERIAL_RATIO;
    const dayInRegime = series[index].quantity >= regimeThreshold;
    const previousInRegime = series[index - 1].quantity >= regimeThreshold;

    candidates.push({
      index,
      pre,
      post,
      change: Math.abs((post - pre) / pre),
      onset: post >= regimeThreshold && dayInRegime && !previousInRegime
    });
  }

  if (candidates.length === 0) {
    return emptyResult(series.length, "no candidate day had a usable baseline");
  }

  const onsets = candidates.filter((c) => c.onset);
  const pool = onsets.length > 0 ? onsets : candidates;
  // Ties resolve to the earliest date; `>` keeps the first maximum found.
  const best = pool.reduce((winner, c) => (c.change > winner.change ? c : winner));

  const ratio = best.post / best.pre;
  const changeIndex = best.index;
  const remainingDays = series.length - changeIndex;
  const projectedExtraQuantity = Math.max(
    0,
    Math.round((best.post - best.pre) * remainingDays)
  );
  const projectedCostImpactCents = price
    ? rateCents(projectedExtraQuantity, price.overageRateCents, price.unitDivisor)
    : 0;

  const material =
    ratio >= MATERIAL_RATIO &&
    (price === undefined ||
      projectedCostImpactCents >= MATERIAL_COST_IMPACT_CENTS);

  return {
    detected: true,
    changeDate: series[changeIndex].date,
    baselineDailyQuantity: best.pre,
    postChangeDailyQuantity: best.post,
    ratio,
    material,
    projectedCostImpactCents,
    confidence: material ? "high" : ratio >= 1.2 ? "medium" : "low",
    method: CHANGE_POINT_METHOD,
    preWindow: {
      from: series[changeIndex - PRE_WINDOW_DAYS].date,
      to: series[changeIndex - 1].date
    },
    postWindow: {
      from: series[changeIndex].date,
      to: series[changeIndex + POST_WINDOW_DAYS - 1].date
    },
    pointsEvaluated: series.length
  };
}

export interface CorrelatedEvent<T> {
  event: T;
  hoursFromChange: number;
}

/**
 * Events within ±24 hours of the change point, nearest first. PRD §12.8.
 * Temporal proximity only — this never asserts causation.
 */
export function correlateEvents<T extends { occurredAt: string }>(
  events: T[],
  changeDate: IsoDate,
  windowHours = 24
): CorrelatedEvent<T>[] {
  const anchor = Date.parse(`${changeDate}T00:00:00Z`);
  return events
    .map((event) => ({
      event,
      hoursFromChange: (Date.parse(event.occurredAt) - anchor) / 3_600_000
    }))
    .filter((c) => Math.abs(c.hoursFromChange) <= windowHours)
    .sort(
      (a, b) => Math.abs(a.hoursFromChange) - Math.abs(b.hoursFromChange)
    );
}

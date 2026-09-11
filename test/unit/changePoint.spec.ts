import { day, q } from "./../support/values.js";
import { describe, expect, it } from "vitest";
import {
  correlateEvents,
  detectChangePoint,
  median,
  MIN_DATA_POINTS,
  type DailyPoint
} from "../../src/domain/changePoint.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { WORKERS_PRICE } from "../../seed/constants.js";

const dataset = generateSyntheticData();
const price = { ...WORKERS_PRICE, accountId: "abc123" };

function augustWorkersSeries(): DailyPoint[] {
  const byDate = new Map<string, number>();
  for (const row of dataset.dailyUsage) {
    if (row.serviceName !== "Workers") continue;
    if (!row.usageDate.startsWith("2026-08")) continue;
    byDate.set(row.usageDate, (byDate.get(row.usageDate) ?? 0) + row.quantity);
  }
  return [...byDate.entries()]
    .map(([date, total]) => ({ date: day(date), quantity: q(total) }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

describe("median", () => {
  it("handles odd and even lengths", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("change-point detection", () => {
  const series = augustWorkersSeries();
  const result = detectChangePoint(series, price);

  it("selects August 14", () => {
    expect(result.detected).toBe(true);
    expect(result.changeDate).toBe("2026-08-14");
  });

  it("marks the shift material", () => {
    expect(result.material).toBe(true);
    expect(result.ratio).toBeGreaterThanOrEqual(1.5);
    expect(result.projectedCostImpactCents).toBeGreaterThanOrEqual(10_000);
    expect(result.confidence).toBe("high");
  });

  it("reports the windows and method it used", () => {
    expect(result.preWindow).toEqual({ from: "2026-08-07", to: "2026-08-13" });
    expect(result.postWindow).toEqual({ from: "2026-08-14", to: "2026-08-18" });
    expect(result.method).toMatch(/median/);
    expect(result.pointsEvaluated).toBe(31);
  });

  it("sees roughly a doubling of daily volume", () => {
    expect(result.postChangeDailyQuantity).toBeGreaterThan(
      result.baselineDailyQuantity * 1.5
    );
  });

  it("does not pick the day before or after the onset", () => {
    // The neighbours' window medians are close enough that a naive scan could
    // land on either; the onset rule has to break that tie.
    expect(result.changeDate).not.toBe("2026-08-13");
    expect(result.changeDate).not.toBe("2026-08-15");
  });

  it("refuses to guess with too few points", () => {
    const short = series.slice(0, MIN_DATA_POINTS - 1);
    const outcome = detectChangePoint(short, price);
    expect(outcome.detected).toBe(false);
    expect(outcome.changeDate).toBeNull();
    expect(outcome.reason).toMatch(/at least 14/);
  });

  it("reports no material change on a flat series", () => {
    const flat: DailyPoint[] = Array.from({ length: 31 }, (_, i) => ({
      date: day(`2026-08-${String(i + 1).padStart(2, "0")}`),
      quantity: q(32_000_000)
    }));
    const outcome = detectChangePoint(flat, price);
    expect(outcome.material).toBe(false);
    expect(outcome.ratio).toBe(1);
  });
});

describe("event correlation", () => {
  const correlated = correlateEvents(dataset.accountEvents, day("2026-08-14"));

  it("ranks dep-1842 first by temporal proximity", () => {
    expect(correlated[0].event.eventId).toBe("dep-1842");
    expect(correlated[0].event.name).toBe("edge-router-v3");
    expect(correlated[0].event.zoneId).toBe("zone-api-acme");
  });

  it("keeps only events inside the +/-24 hour window", () => {
    expect(correlated.every((c) => Math.abs(c.hoursFromChange) <= 24)).toBe(true);
    // The July deployment is far outside the window.
    expect(correlated.map((c) => c.event.eventId)).not.toContain("dep-1790");
  });

  it("orders by absolute distance from the change", () => {
    const distances = correlated.map((c) => Math.abs(c.hoursFromChange));
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });
});

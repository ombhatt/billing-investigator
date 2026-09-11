import { c, day, per, q } from "./../support/values.js";
import { describe, expect, it } from "vitest";
import {
  effectivePrice,
  priceChanged,
  priceVersionsOverlapping,
  rateUsage
} from "../../src/domain/rating.js";
import { assertPeriod, daysInPeriod, isWeekend } from "../../src/domain/period.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { consumedInPeriod } from "../../src/domain/invoice.js";
import { WORKERS_PRICE, WORKERS_AI_PRICE } from "../../seed/constants.js";

const workersPrice = { ...WORKERS_PRICE, accountId: "abc123" };
const dataset = generateSyntheticData();

describe("rating", () => {
  it("rates Workers for July at $7,200", () => {
    const consumed = consumedInPeriod(dataset.dailyUsage, "Workers", per("2026-07"));
    expect(consumed).toBe(1_000_000_000);

    const rated = rateUsage(consumed, workersPrice);
    expect(rated.includedQuantity).toBe(100_000_000);
    expect(rated.billableQuantity).toBe(900_000_000);
    expect(rated.amountCents).toBe(720_000);
  });

  it("rates Workers for August at $11,840", () => {
    const consumed = consumedInPeriod(dataset.dailyUsage, "Workers", per("2026-08"));
    expect(consumed).toBe(1_580_000_000);

    const rated = rateUsage(consumed, workersPrice);
    expect(rated.billableQuantity).toBe(1_480_000_000);
    expect(rated.amountCents).toBe(1_184_000);
  });

  it("rates Workers AI at $150 for July and $330 for August", () => {
    const price = { ...WORKERS_AI_PRICE, accountId: "abc123" };
    expect(
      rateUsage(consumedInPeriod(dataset.dailyUsage, "Workers AI", per("2026-07")), price)
        .amountCents
    ).toBe(15_000);
    expect(
      rateUsage(consumedInPeriod(dataset.dailyUsage, "Workers AI", per("2026-08")), price)
        .amountCents
    ).toBe(33_000);
  });

  it("never bills below the included allowance", () => {
    const rated = rateUsage(q(50_000_000), workersPrice);
    expect(rated.billableQuantity).toBe(0);
    expect(rated.amountCents).toBe(0);
  });

  it("adds a fixed fee to the overage charge", () => {
    const rated = rateUsage(q(101_000_000), { ...workersPrice, fixedFeeCents: c(5_000) });
    expect(rated.amountCents).toBe(5_000 + 800);
  });
});

describe("price versions", () => {
  it("reports no price change across July and August", () => {
    expect(
      priceChanged(dataset.priceVersions, "Workers", day("2026-07-01"), day("2026-08-31"))
    ).toBe(false);
    expect(
      priceChanged(dataset.priceVersions, "Workers AI", day("2026-07-01"), day("2026-08-31"))
    ).toBe(false);
  });

  it("returns the single overlapping version with its identifier", () => {
    const versions = priceVersionsOverlapping(
      dataset.priceVersions,
      "Workers",
      day("2026-07-01"),
      day("2026-08-31")
    );
    expect(versions).toHaveLength(1);
    expect(versions[0].priceVersionId).toBe("price-workers-2026-01");
    expect(versions[0].effectiveFrom).toBe("2026-01-01");
    expect(versions[0].effectiveTo).toBeNull();
  });

  it("detects a change when two versions overlap the window", () => {
    const prices = [
      ...dataset.priceVersions,
      {
        ...workersPrice,
        priceVersionId: "price-workers-2026-08",
        overageRateCents: c(900),
        effectiveFrom: day("2026-08-01"),
        effectiveTo: null
      }
    ];
    expect(priceChanged(prices, "Workers", day("2026-07-01"), day("2026-08-31"))).toBe(true);
    expect(() =>
      effectivePrice(prices, "Workers", day("2026-07-01"), day("2026-08-31"))
    ).toThrow(/price versions/);
  });

  it("rejects an unknown service rather than guessing a price", () => {
    expect(() =>
      effectivePrice(dataset.priceVersions, "Nonexistent", day("2026-07-01"), day("2026-07-31"))
    ).toThrow(/no price version/);
  });
});

describe("period helpers", () => {
  it("rejects an invalid period", () => {
    expect(() => assertPeriod("2026-13")).toThrow(RangeError);
    expect(() => assertPeriod("2026-8")).toThrow(RangeError);
    expect(() => assertPeriod("not-a-period")).toThrow(RangeError);
  });

  it("counts days without drifting on timezone", () => {
    expect(daysInPeriod(per("2026-06"))).toBe(30);
    expect(daysInPeriod(per("2026-07"))).toBe(31);
    expect(daysInPeriod(per("2026-02"))).toBe(28);
  });

  it("identifies weekends in UTC", () => {
    expect(isWeekend(day("2026-08-01"))).toBe(true); // Saturday
    expect(isWeekend(day("2026-08-02"))).toBe(true); // Sunday
    expect(isWeekend(day("2026-08-14"))).toBe(false); // Friday
  });
});

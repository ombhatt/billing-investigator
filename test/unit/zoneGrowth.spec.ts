import { describe, expect, it } from "vitest";
import { primaryGrowthZone, zoneGrowth } from "../../src/domain/zoneGrowth.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";

/**
 * A zone's share of the period is not its share of the growth.
 *
 * Review found the required follow-up "which zone generated the increase?"
 * answerable only by guessing from August's distribution: the primary zone
 * holds 83% of August usage but contributed 96% of the additional requests.
 * The two numbers are close enough here to look like a rounding difference and
 * are answers to different questions — which is exactly why the confusion
 * survived.
 */

const zone = (zoneId: string, quantity: number) => ({ zoneId, quantity });

describe("share of growth is not share of the period", () => {
  it("separates the two for the same data", () => {
    // api holds 80% of the current period but produced all of the growth.
    const growth = zoneGrowth(
      [zone("api", 800), zone("cdn", 200)],
      [zone("api", 300), zone("cdn", 200)]
    );
    const api = growth.find((z) => z.zoneId === "api")!;

    expect(api.shareOfCurrentPercent).toBe(80);
    expect(api.shareOfGrowthPercent).toBe(100);
  });

  it("reports no growth for the largest zone when it did not grow", () => {
    // The case review asked for: the biggest zone by volume contributed
    // nothing to the change, and a period-share answer would name it.
    const growth = zoneGrowth(
      [zone("big", 9000), zone("small", 1100)],
      [zone("big", 9000), zone("small", 100)]
    );

    const big = growth.find((z) => z.zoneId === "big")!;
    const small = growth.find((z) => z.zoneId === "small")!;

    expect(big.shareOfCurrentPercent).toBeCloseTo(89.1, 1);
    expect(big.deltaQuantity).toBe(0);
    expect(big.shareOfGrowthPercent).toBe(0);

    expect(small.shareOfCurrentPercent).toBeCloseTo(10.9, 1);
    expect(small.shareOfGrowthPercent).toBe(100);

    // And the ordering answers the question directly.
    expect(primaryGrowthZone(growth)!.zoneId).toBe("small");
  });

  it("keeps a zone that shrank rather than dropping it", () => {
    const growth = zoneGrowth(
      [zone("up", 1000), zone("gone", 0)],
      [zone("up", 400), zone("gone", 100)]
    );

    const gone = growth.find((z) => z.zoneId === "gone")!;
    expect(gone.deltaQuantity).toBe(-100);
    expect(gone.currentQuantity).toBe(0);
    // One zone grew by more than the net increase because another shrank.
    expect(growth.find((z) => z.zoneId === "up")!.shareOfGrowthPercent).toBeCloseTo(
      120,
      5
    );
  });

  it("includes a zone that appeared only in the current period", () => {
    const growth = zoneGrowth([zone("new", 500)], [zone("old", 500)]);
    expect(growth.map((z) => z.zoneId).sort()).toEqual(["new", "old"]);
    expect(growth.find((z) => z.zoneId === "new")!.comparisonQuantity).toBe(0);
  });

  it("declines to express a share of growth when usage did not grow", () => {
    const growth = zoneGrowth([zone("a", 100)], [zone("a", 300)]);
    expect(growth[0].shareOfGrowthPercent).toBeNull();
    expect(growth[0].deltaQuantity).toBe(-200);
    expect(primaryGrowthZone(growth)).toBeNull();
  });

  it("handles an empty comparison without dividing by zero", () => {
    const growth = zoneGrowth([zone("a", 100)], []);
    expect(growth[0].shareOfGrowthPercent).toBe(100);
    expect(zoneGrowth([], [])).toEqual([]);
  });
});

describe("the seeded August, which is the case review measured", () => {
  const dataset = generateSyntheticData();
  const workers = (period: string) =>
    dataset.dailyUsage
      .filter((d) => d.serviceName === "Workers" && d.usageDate.startsWith(period))
      .map((d) => ({ zoneId: d.zoneId, quantity: d.quantity }));

  const growth = zoneGrowth(workers("2026-08"), workers("2026-07"));
  const primary = primaryGrowthZone(growth)!;

  it("names the primary zone as the source of the increase", () => {
    expect(primary.zoneId).toBe("zone-api-acme");
    expect(primary.deltaQuantity).toBe(556_595_994);
  });

  it("puts its growth share near 96%, not its 83% period share", () => {
    // The exact figures from the review. If these ever coincide the test stops
    // proving anything, so both are asserted.
    expect(primary.shareOfGrowthPercent!).toBeCloseTo(95.96, 1);
    expect(primary.shareOfCurrentPercent).toBeCloseTo(82.7, 1);
    expect(Math.round(primary.shareOfCurrentPercent)).toBe(83);
    expect(Math.round(primary.shareOfGrowthPercent!)).not.toBe(
      Math.round(primary.shareOfCurrentPercent)
    );
  });

  it("accounts for the whole increase across zones", () => {
    const net = growth.reduce((sum, z) => sum + z.deltaQuantity, 0);
    expect(net).toBe(580_000_000);
    const shares = growth.reduce((sum, z) => sum + (z.shareOfGrowthPercent ?? 0), 0);
    expect(shares).toBeCloseTo(100, 6);
  });
});

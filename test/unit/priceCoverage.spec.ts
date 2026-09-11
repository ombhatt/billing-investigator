import { day, per } from "./../support/values.js";
import { describe, expect, it } from "vitest";
import {
  coverageGap,
  covers,
  effectivePrice,
  priceChanged,
  priceVersionsOverlapping
} from "../../src/domain/rating.js";
import { generateRatedCharges } from "../../src/domain/invoice.js";
import { reconcileInvoice } from "../../src/domain/reconciliation.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { WORKERS_PRICE } from "../../seed/constants.js";
import type { PriceVersion } from "../../src/domain/types.js";

/**
 * Overlap is not coverage.
 *
 * Review showed a sole price version effective from August 14 being accepted to
 * rate August 1-31: it overlapped the month, so it was selected, and the first
 * thirteen days were priced by a contract that did not yet apply. Invoice
 * generation repeated the same overlap-only selection independently.
 */

const AUGUST_START = day("2026-08-01");
const AUGUST_END = day("2026-08-31");

const version = (
  effectiveFrom: string,
  effectiveTo: string | null
): PriceVersion => ({
  ...WORKERS_PRICE,
  accountId: "abc123",
  effectiveFrom: day(effectiveFrom),
  effectiveTo: effectiveTo === null ? null : day(effectiveTo)
});

describe("covers distinguishes coverage from overlap", () => {
  it("accepts a version spanning the whole window", () => {
    expect(covers(version("2026-01-01", null), AUGUST_START, AUGUST_END)).toBe(true);
    expect(covers(version("2026-08-01", "2026-08-31"), AUGUST_START, AUGUST_END)).toBe(
      true
    );
  });

  it("rejects one that starts after the window opens", () => {
    expect(covers(version("2026-08-14", null), AUGUST_START, AUGUST_END)).toBe(false);
  });

  it("rejects one that ends before the window closes", () => {
    expect(covers(version("2026-01-01", "2026-08-10"), AUGUST_START, AUGUST_END)).toBe(
      false
    );
  });

  it("rejects one that only sits inside the window", () => {
    expect(covers(version("2026-08-10", "2026-08-20"), AUGUST_START, AUGUST_END)).toBe(
      false
    );
  });
});

describe("effectivePrice refuses to rate a period it cannot price", () => {
  const rate = (prices: PriceVersion[]) =>
    effectivePrice(prices, "Workers", AUGUST_START, AUGUST_END);

  it("returns the version when it covers the window", () => {
    expect(rate([version("2026-01-01", null)]).priceVersionId).toBe(
      "price-workers-2026-01"
    );
  });

  it("rejects a sole version that starts late", () => {
    // The exact case from review: accepted before, and priced Aug 1-13 wrongly.
    expect(() => rate([version("2026-08-14", null)])).toThrow(/does not span/);
  });

  it("rejects a sole version that ends early", () => {
    expect(() => rate([version("2026-01-01", "2026-08-10")])).toThrow(
      /does not span/
    );
  });

  it("rejects a sole version covering only the middle", () => {
    expect(() => rate([version("2026-08-10", "2026-08-20")])).toThrow(
      /does not span/
    );
  });

  it("still rejects a mid-period price change", () => {
    expect(() =>
      rate([version("2026-01-01", "2026-08-13"), version("2026-08-14", null)])
    ).toThrow(/P0 rates one version per period/);
  });

  it("still rejects an absent price", () => {
    expect(() => rate([])).toThrow(/no price version/);
  });

  it("names the version and its dates so the gap is diagnosable", () => {
    expect(() => rate([version("2026-08-14", null)])).toThrow(
      /price-workers-2026-01 covers 2026-08-14\.\.open/
    );
  });
});

describe("coverageGap reports the shortfall without throwing", () => {
  const gap = (prices: PriceVersion[]) =>
    coverageGap(prices, "Workers", AUGUST_START, AUGUST_END);

  it("is false when the window is fully covered", () => {
    expect(gap([version("2026-01-01", null)])).toBe(false);
  });

  it("is true when no version exists", () => {
    expect(gap([])).toBe(true);
  });

  it("is true for a late start or an early end", () => {
    expect(gap([version("2026-08-14", null)])).toBe(true);
    expect(gap([version("2026-01-01", "2026-08-10")])).toBe(true);
  });

  it("is false for a mid-period change, which is a change and not a gap", () => {
    const split = [version("2026-01-01", "2026-08-13"), version("2026-08-14", null)];
    expect(gap(split)).toBe(false);
    expect(priceChanged(split, "Workers", AUGUST_START, AUGUST_END)).toBe(true);
    expect(
      priceVersionsOverlapping(split, "Workers", AUGUST_START, AUGUST_END)
    ).toHaveLength(2);
  });
});

describe("invoice generation applies the same rule", () => {
  const dataset = generateSyntheticData();
  const augustDaily = dataset.dailyUsage.filter((d) =>
    d.usageDate.startsWith("2026-08")
  );

  it("rates the golden month normally", () => {
    const charges = generateRatedCharges(
      "abc123",
      per("2026-08"),
      augustDaily,
      dataset.priceVersions
    );
    expect(charges.find((c) => c.serviceName === "Workers")!.amountCents).toBe(
      1_184_000
    );
  });

  it("refuses to generate a charge from a partially effective price", () => {
    // Previously this repeated the overlap-only filter in its own code, so the
    // defect existed in two places independently.
    const late = dataset.priceVersions.map((p) =>
      p.serviceName === "Workers" ? { ...p, effectiveFrom: day("2026-08-14") } : p
    );
    expect(() =>
      generateRatedCharges("abc123", per("2026-08"), augustDaily, late)
    ).toThrow(/does not span/);
  });
});

describe("reconciliation fails rather than rating an uncovered period", () => {
  const dataset = generateSyntheticData();
  const invoice = dataset.invoices.find((i) => i.period === "2026-08")!;

  it("fails the price-version boundary when coverage is partial", () => {
    const report = reconcileInvoice({
      accountId: "abc123",
      period: per("2026-08"),
      usageEvents: dataset.usageEvents,
      dailyUsage: dataset.dailyUsage,
      ratedCharges: dataset.ratedCharges,
      prices: dataset.priceVersions.map((p) =>
        p.serviceName === "Workers" ? { ...p, effectiveFrom: day("2026-08-14") } : p
      ),
      invoice,
      invoiceLines: dataset.invoiceLines.filter(
        (l) => l.invoiceId === invoice.invoiceId
      ),
      subscriptions: dataset.subscriptions
    });

    expect(report.status).toBe("failed");
    const failed = report.checkpoints.filter((c) => !c.passed);
    expect(failed.map((c) => c.boundary)).toContain("rated_charge_price_version");
  });
});

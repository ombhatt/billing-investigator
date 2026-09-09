import { describe, expect, it } from "vitest";
import { compareInvoices } from "../../src/domain/compare.js";
import {
  decomposeVariance,
  explainedPercent
} from "../../src/domain/variance.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";

const dataset = generateSyntheticData();

function sideFor(period: string) {
  const invoice = dataset.invoices.find((i) => i.period === period)!;
  return {
    invoice,
    lines: dataset.invoiceLines.filter((l) => l.invoiceId === invoice.invoiceId)
  };
}

const current = sideFor("2026-08");
const comparison = sideFor("2026-07");
const comparisonResult = compareInvoices(current, comparison);

/**
 * Identical July consumption, an August contract reprice from $8 to $9 per
 * million, and optionally a different August quantity. Built by hand so the
 * expected effects can be reasoned about directly.
 */
function repricingScenario(augustQuantity = 1_000_000_000) {
  const base = {
    accountId: "abc123",
    serviceName: "Workers",
    serviceFamily: "Workers",
    includedQuantity: 100_000_000,
    unitDivisor: 1_000_000,
    unit: "requests",
    fixedFeeCents: 0
  };
  const prices = [
    {
      ...base,
      priceVersionId: "pv-old",
      overageRateCents: 800,
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-07-31"
    },
    {
      ...base,
      priceVersionId: "pv-new",
      overageRateCents: 900,
      effectiveFrom: "2026-08-01",
      effectiveTo: null
    }
  ];

  const daily = [
    { period: "2026-07", date: "2026-07-15", quantity: 1_000_000_000 },
    { period: "2026-08", date: "2026-08-15", quantity: augustQuantity }
  ].map((d) => ({
    accountId: "abc123",
    serviceName: "Workers",
    zoneId: "zone-api-acme",
    usageDate: d.date,
    quantity: d.quantity,
    unit: "requests",
    sourceEventCount: 1,
    sourceEventFirst: `${d.date}T00:20:00Z`,
    sourceEventLast: `${d.date}T00:20:00Z`
  }));

  const side = (period: string, quantity: number, rate: number) => {
    const amountCents = ((quantity - 100_000_000) / 1_000_000) * rate;
    const invoiceId = `inv-${period}`;
    return {
      invoice: {
        invoiceId,
        accountId: "abc123",
        period,
        status: "finalized",
        currency: "USD",
        subtotalCents: amountCents,
        creditCents: 0,
        taxCents: 0,
        totalCents: amountCents,
        issuedOn: `${period}-28`
      },
      lines: [
        {
          lineId: `${invoiceId}-workers`,
          invoiceId,
          accountId: "abc123",
          serviceName: "Workers",
          lineType: "usage" as const,
          quantity,
          amountCents,
          ratedChargeId: `rc-${period}`,
          subscriptionId: null
        }
      ]
    };
  };

  return {
    currentPeriod: "2026-08",
    comparisonPeriod: "2026-07",
    daily,
    prices,
    current: side("2026-08", augustQuantity, 900),
    comparison: side("2026-07", 1_000_000_000, 800)
  };
}

describe("invoice comparison", () => {
  it("reports the golden totals and variance", () => {
    expect(comparisonResult.comparisonTotalCents).toBe(1_690_000);
    expect(comparisonResult.currentTotalCents).toBe(2_172_000);
    expect(comparisonResult.varianceCents).toBe(482_000);
  });

  it("displays the percentage change as 28.5%", () => {
    expect(comparisonResult.percentageVariance).toBeCloseTo(28.52071, 5);
    expect(comparisonResult.percentageVarianceDisplay).toBe(28.5);
  });

  it("attributes $4,640 to Workers and $180 to Workers AI", () => {
    const byName = new Map(
      comparisonResult.services.map((s) => [s.serviceName, s.varianceCents])
    );
    expect(byName.get("Workers")).toBe(464_000);
    expect(byName.get("Workers AI")).toBe(18_000);
  });

  it("shows no movement on the fixed lines", () => {
    const byName = new Map(
      comparisonResult.services.map((s) => [s.serviceName, s.varianceCents])
    );
    expect(byName.get("Platform fee")).toBe(0);
    expect(byName.get("R2")).toBe(0);
    expect(byName.get("D1")).toBe(0);
  });

  it("ranks Workers as the largest driver", () => {
    expect(comparisonResult.rankedDrivers[0].serviceName).toBe("Workers");
    expect(comparisonResult.rankedDrivers[1].serviceName).toBe("Workers AI");
    expect(comparisonResult.rankedDrivers).toHaveLength(2);
  });

  it("has service variances summing to the invoice variance", () => {
    expect(comparisonResult.explainedCents).toBe(
      comparisonResult.varianceCents
    );
  });

  it("returns a null percentage when the comparison total is zero", () => {
    const zeroed = {
      invoice: { ...comparison.invoice, totalCents: 0 },
      lines: comparison.lines
    };
    const result = compareInvoices(current, zeroed);
    expect(result.percentageVariance).toBeNull();
    expect(result.percentageVarianceDisplay).toBeNull();
    expect(Number.isNaN(result.varianceCents)).toBe(false);
  });
});

describe("variance decomposition", () => {
  const decomposition = decomposeVariance({
    currentPeriod: "2026-08",
    comparisonPeriod: "2026-07",
    daily: dataset.dailyUsage,
    prices: dataset.priceVersions,
    current,
    comparison
  });

  it("attributes the whole movement to volume, none to price", () => {
    expect(decomposition.volumeEffectCents).toBe(482_000);
    expect(decomposition.priceEffectCents).toBe(0);
    expect(decomposition.fixedFeeEffectCents).toBe(0);
    expect(decomposition.creditEffectCents).toBe(0);
    expect(decomposition.taxEffectCents).toBe(0);
  });

  it("has volume and price effects summing to the total variance", () => {
    expect(decomposition.totalEffectCents).toBe(
      decomposition.invoiceVarianceCents
    );
    expect(decomposition.unexplainedCents).toBe(0);
  });

  it("explains 100% of the variance", () => {
    expect(decomposition.explainedPercent).toBe(100);
  });

  it("splits the volume effect per service", () => {
    const byName = new Map(
      decomposition.services.map((s) => [s.serviceName, s])
    );
    expect(byName.get("Workers")!.volumeEffectCents).toBe(464_000);
    expect(byName.get("Workers")!.priceEffectCents).toBe(0);
    expect(byName.get("Workers AI")!.volumeEffectCents).toBe(18_000);
    expect(byName.get("Workers")!.currentQuantity).toBe(1_580_000_000);
    expect(byName.get("Workers")!.comparisonQuantity).toBe(1_000_000_000);
  });

  it("records the price versions it rated against", () => {
    expect(decomposition.priceVersionIds).toContain("price-workers-2026-01");
    expect(decomposition.priceVersionIds).toContain("price-workers-ai-2026-01");
  });

  it("isolates a price effect when the rate moves and volume does not", () => {
    // Identical consumption both months, but the contract reprices on Aug 1.
    // The whole movement must land on price and none on volume.
    const scenario = repricingScenario();
    const result = decomposeVariance(scenario);

    // 900M billable at +$1.00 per million = +$900.00
    expect(result.priceEffectCents).toBe(90_000);
    expect(result.volumeEffectCents).toBe(0);
    expect(result.totalEffectCents).toBe(result.invoiceVarianceCents);
    expect(result.unexplainedCents).toBe(0);
  });

  it("splits a simultaneous price and volume move without overlap", () => {
    // Consumption up 100M and the rate up $1.00 in the same month.
    const scenario = repricingScenario(1_100_000_000);
    const result = decomposeVariance(scenario);

    // volume at the old rate: (1000M - 900M billable) x $8.00 = +$800.00
    expect(result.volumeEffectCents).toBe(80_000);
    // price on the new quantity: 1000M billable x +$1.00 = +$1,000.00
    expect(result.priceEffectCents).toBe(100_000);
    expect(result.totalEffectCents).toBe(result.invoiceVarianceCents);
    expect(result.unexplainedCents).toBe(0);
  });
});

describe("percent explained", () => {
  it("clamps to [0, 100]", () => {
    expect(explainedPercent(0, 482_000)).toBe(100);
    expect(explainedPercent(482_000, 482_000)).toBe(0);
    expect(explainedPercent(1_000_000, 482_000)).toBe(0);
    expect(explainedPercent(241_000, 482_000)).toBe(50);
  });

  it("treats a zero variance with nothing unexplained as fully explained", () => {
    expect(explainedPercent(0, 0)).toBe(100);
    expect(explainedPercent(5, 0)).toBe(0);
  });
});

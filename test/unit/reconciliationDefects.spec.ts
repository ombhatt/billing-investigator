import { describe, expect, it } from "vitest";
import { reconcileInvoice } from "../../src/domain/reconciliation.js";
import type { ReconciliationReport } from "../../src/domain/reconciliation.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";

/**
 * Reconciliation is the trust anchor: nothing may be called correct without it.
 * Review found the original could report "passed" while the pipeline was
 * demonstrably broken — most starkly, with every usage row and rated charge
 * deleted, because the per-service loop was driven off raw usage and simply ran
 * zero times.
 *
 * Each case here corrupts or removes exactly one thing and asserts the specific
 * boundary that should notice it does.
 */

const dataset = generateSyntheticData();
const PERIOD = "2026-08";
const invoice = dataset.invoices.find((i) => i.period === PERIOD)!;
const lines = dataset.invoiceLines.filter(
  (l) => l.invoiceId === invoice.invoiceId
);

type Input = Parameters<typeof reconcileInvoice>[0];

const base: Input = {
  accountId: "abc123",
  period: PERIOD,
  usageEvents: dataset.usageEvents,
  dailyUsage: dataset.dailyUsage,
  ratedCharges: dataset.ratedCharges,
  prices: dataset.priceVersions,
  invoice,
  invoiceLines: lines,
  subscriptions: dataset.subscriptions
};

const run = (overrides: Partial<Input> = {}): ReconciliationReport =>
  reconcileInvoice({ ...base, ...overrides });

/** The boundaries that failed, so a case can name the one it targets. */
const failedBoundaries = (report: ReconciliationReport) =>
  new Set(report.checkpoints.filter((c) => !c.passed).map((c) => c.boundary));

const workersCharge = (mutate: (r: (typeof dataset.ratedCharges)[number]) => object) =>
  dataset.ratedCharges.map((r) =>
    r.period === PERIOD && r.serviceName === "Workers" ? { ...r, ...mutate(r) } : r
  );

describe("the golden pipeline reconciles", () => {
  it("passes with every boundary at zero", () => {
    const report = run();
    expect(report.status).toBe("passed");
    expect(report.checkpoints.every((c) => c.passed)).toBe(true);
    expect(report.totalQuantityDiscrepancy).toBe(0);
    expect(report.totalDiscrepancyCents).toBe(0);
  });

  it("checks every metered service at every stage", () => {
    const report = run();
    const coverage = report.checkpoints.filter(
      (c) => c.boundary === "stage_coverage"
    );
    expect(coverage.map((c) => c.scope).sort()).toEqual([
      "Workers",
      "Workers AI"
    ]);
    for (const c of coverage) expect(c.actual).toBe(4);
  });
});

describe("a missing stage fails, not just a disagreeing one", () => {
  it("fails when the whole usage pipeline is absent but the invoice remains", () => {
    // The original returned "passed" here with a single checkpoint: an invoice
    // certified correct with nothing whatsoever behind it.
    const report = run({ usageEvents: [], dailyUsage: [], ratedCharges: [] });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("stage_coverage");
  });

  it("fails when raw usage events are gone", () => {
    const report = run({ usageEvents: [] });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("raw_usage_vs_daily_aggregate");
  });

  it("fails when daily aggregates are gone", () => {
    const report = run({ dailyUsage: [] });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("stage_coverage");
  });

  it("fails when rated charges are gone", () => {
    const report = run({ ratedCharges: [] });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("stage_coverage");
  });

  it("fails when the usage invoice lines are gone", () => {
    const report = run({
      invoiceLines: lines.filter((l) => l.lineType !== "usage")
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("stage_coverage");
  });

  it("fails on a single dropped usage event", () => {
    const report = run({
      usageEvents: dataset.usageEvents.filter(
        (e) => e.eventId !== "ue-workers-2026-08-20-zone-api-acme-13"
      )
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("raw_usage_vs_daily_aggregate");
  });
});

describe("a corrupted stored field fails its own boundary", () => {
  it("catches a tampered rated-charge amount", () => {
    // Previously invisible: recomputation was compared to the invoice line, so
    // the stored rated charge was never examined at all.
    const report = run({ ratedCharges: workersCharge(() => ({ amountCents: 1 })) });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain(
      "recomputed_charge_vs_rated_charge"
    );
  });

  it("catches a tampered consumed quantity", () => {
    const report = run({
      ratedCharges: workersCharge((r) => ({
        consumedQuantity: r.consumedQuantity - 1_000_000
      }))
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain(
      "daily_aggregate_vs_rated_quantity"
    );
  });

  it("catches a rated charge that breaks its own billable arithmetic", () => {
    const report = run({
      ratedCharges: workersCharge(() => ({
        billableQuantity: 7,
        includedQuantity: 9
      }))
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain(
      "rated_charge_internal_consistency"
    );
  });

  it("catches a rated charge citing the wrong price version", () => {
    const report = run({
      ratedCharges: workersCharge(() => ({ priceVersionId: "price-bogus" }))
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("rated_charge_price_version");
  });

  it("catches an invoice line that disagrees with its rated charge", () => {
    const report = run({
      invoiceLines: lines.map((l) =>
        l.serviceName === "Workers" && l.lineType === "usage"
          ? { ...l, amountCents: l.amountCents + 100 }
          : l
      )
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("rated_charge_vs_invoice_line");
  });

  it("catches a tampered invoice subtotal", () => {
    // The old implementation never read subtotalCents at all.
    const report = run({ invoice: { ...invoice, subtotalCents: 1 } });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("invoice_lines_vs_subtotal");
  });

  it("catches a tampered invoice total", () => {
    const report = run({
      invoice: { ...invoice, totalCents: invoice.totalCents + 1 }
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("invoice_components_vs_total");
  });

  it("uses no tolerance: one cent fails", () => {
    expect(
      run({ invoice: { ...invoice, totalCents: invoice.totalCents - 1 } }).status
    ).toBe("failed");
  });
});

describe("broken linkage and stray records fail", () => {
  it("catches a usage line not linked to any rated charge", () => {
    const report = run({
      invoiceLines: lines.map((l) =>
        l.lineType === "usage" ? { ...l, ratedChargeId: null } : l
      )
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("invoice_line_linkage");
  });

  it("catches a usage line pointing at a rated charge that does not exist", () => {
    const report = run({
      invoiceLines: lines.map((l) =>
        l.lineType === "usage" ? { ...l, ratedChargeId: "rc-missing" } : l
      )
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("invoice_line_linkage");
  });

  it("catches an orphan rated charge with no usage and no line", () => {
    const report = run({
      ratedCharges: [
        ...dataset.ratedCharges,
        {
          ratedChargeId: "rc-orphan",
          accountId: "abc123",
          serviceName: "Ghost",
          period: PERIOD,
          consumedQuantity: 999,
          includedQuantity: 0,
          billableQuantity: 999,
          priceVersionId: "price-workers-2026-01",
          amountCents: 500_000
        }
      ]
    });
    expect(report.status).toBe("failed");
    const ghost = report.checkpoints.filter((c) => c.scope === "Ghost");
    expect(ghost.length).toBeGreaterThan(0);
    expect(failedBoundaries(report)).toContain("stage_coverage");
  });

  it("catches an extra usage line for a service with no usage behind it", () => {
    const report = run({
      invoiceLines: [
        ...lines,
        {
          lineId: "extra",
          invoiceId: invoice.invoiceId,
          accountId: "abc123",
          serviceName: "Phantom",
          lineType: "usage" as const,
          quantity: 1,
          amountCents: 100_000,
          ratedChargeId: null,
          subscriptionId: null
        }
      ]
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("stage_coverage");
  });
});

describe("fixed-fee lines are not held to metered expectations", () => {
  it("does not demand usage rows for Platform fee, R2 or D1", () => {
    // These legitimately have invoice lines and no usage pipeline; requiring
    // coverage for them would fail the golden scenario.
    const report = run();
    const scopes = report.checkpoints
      .filter((c) => c.boundary === "stage_coverage")
      .map((c) => c.scope);
    expect(scopes).not.toContain("Platform fee");
    expect(scopes).not.toContain("R2");
    expect(scopes).not.toContain("D1");
    expect(report.status).toBe("passed");
  });

  it("still counts their amounts toward the subtotal", () => {
    const report = run({
      invoiceLines: lines.filter((l) => l.serviceName !== "R2")
    });
    expect(report.status).toBe("failed");
    expect(failedBoundaries(report)).toContain("invoice_lines_vs_subtotal");
  });
});

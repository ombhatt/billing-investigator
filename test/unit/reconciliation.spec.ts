import { describe, expect, it } from "vitest";
import { reconcileInvoice } from "../../src/domain/reconciliation.js";
import { evaluateConfidence } from "../../src/domain/confidence.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";

const dataset = generateSyntheticData();

function reconcile(period: string, overrides: Partial<Parameters<typeof reconcileInvoice>[0]> = {}) {
  const invoice = dataset.invoices.find((i) => i.period === period)!;
  return reconcileInvoice({
    accountId: dataset.account.accountId,
    period,
    usageEvents: dataset.usageEvents,
    dailyUsage: dataset.dailyUsage,
    ratedCharges: dataset.ratedCharges,
    prices: dataset.priceVersions,
    invoice,
    invoiceLines: dataset.invoiceLines.filter(
      (l) => l.invoiceId === invoice.invoiceId
    ),
    ...overrides
  });
}

describe("reconciliation on the golden scenario", () => {
  const report = reconcile("2026-08");

  it("passes overall", () => {
    expect(report.status).toBe("passed");
  });

  it("returns zero difference at every boundary", () => {
    for (const checkpoint of report.checkpoints) {
      expect(
        `${checkpoint.boundary}/${checkpoint.scope}=${checkpoint.difference}`
      ).toBe(`${checkpoint.boundary}/${checkpoint.scope}=0`);
    }
    expect(report.totalQuantityDiscrepancy).toBe(0);
    expect(report.totalDiscrepancyCents).toBe(0);
  });

  it("covers all four required boundaries", () => {
    const boundaries = new Set(report.checkpoints.map((c) => c.boundary));
    expect(boundaries).toEqual(
      new Set([
        "raw_usage_vs_daily_aggregate",
        "daily_aggregate_vs_rated_quantity",
        "rated_charge_vs_invoice_line",
        "invoice_components_vs_total"
      ])
    );
  });

  it("reconciles July as well", () => {
    expect(reconcile("2026-07").status).toBe("passed");
    expect(reconcile("2026-06").status).toBe("passed");
  });
});

describe("reconciliation catches injected defects", () => {
  it("fails when a usage event is dropped from the raw ledger", () => {
    const trimmed = dataset.usageEvents.filter(
      (e) => e.eventId !== "ue-workers-2026-08-20-zone-api-acme-13"
    );
    const report = reconcile("2026-08", { usageEvents: trimmed });
    expect(report.status).toBe("failed");
    expect(report.totalQuantityDiscrepancy).toBeGreaterThan(0);
    expect(
      report.checkpoints.find(
        (c) => c.boundary === "raw_usage_vs_daily_aggregate" && c.scope === "Workers"
      )!.passed
    ).toBe(false);
  });

  it("fails when a rated charge disagrees with its own price version", () => {
    const tampered = dataset.ratedCharges.map((r) =>
      r.period === "2026-08" && r.serviceName === "Workers"
        ? { ...r, consumedQuantity: r.consumedQuantity - 1_000_000 }
        : r
    );
    const report = reconcile("2026-08", { ratedCharges: tampered });
    expect(report.status).toBe("failed");
    expect(
      report.checkpoints.find(
        (c) => c.boundary === "daily_aggregate_vs_rated_quantity" && c.scope === "Workers"
      )!.difference
    ).toBe(-1_000_000);
  });

  it("fails when an invoice line does not match the recomputed charge", () => {
    const invoice = dataset.invoices.find((i) => i.period === "2026-08")!;
    const lines = dataset.invoiceLines
      .filter((l) => l.invoiceId === invoice.invoiceId)
      .map((l) =>
        l.serviceName === "Workers" && l.lineType === "usage"
          ? { ...l, amountCents: l.amountCents + 100 }
          : l
      );
    const report = reconcile("2026-08", { invoiceLines: lines });
    expect(report.status).toBe("failed");
    expect(
      report.checkpoints.find(
        (c) => c.boundary === "rated_charge_vs_invoice_line" && c.scope === "Workers"
      )!.difference
    ).toBe(100);
  });

  it("fails when the invoice total does not equal its components", () => {
    const invoice = dataset.invoices.find((i) => i.period === "2026-08")!;
    const report = reconcile("2026-08", {
      invoice: { ...invoice, totalCents: invoice.totalCents + 1 }
    });
    expect(report.status).toBe("failed");
    expect(
      report.checkpoints.find(
        (c) => c.boundary === "invoice_components_vs_total"
      )!.difference
    ).toBe(1);
  });

  it("uses no tolerance: a one-cent gap fails", () => {
    const invoice = dataset.invoices.find((i) => i.period === "2026-08")!;
    expect(
      reconcile("2026-08", {
        invoice: { ...invoice, totalCents: invoice.totalCents - 1 }
      }).status
    ).toBe("failed");
  });
});

describe("confidence", () => {
  it("is high on the golden scenario", () => {
    expect(
      evaluateConfidence({
        explainedPercent: 100,
        reconciliationPassed: true,
        requiredChecksComplete: true,
        materialConflict: false
      }).confidence
    ).toBe("high");
  });

  it("drops to medium when reconciliation has not passed", () => {
    expect(
      evaluateConfidence({
        explainedPercent: 100,
        reconciliationPassed: false,
        requiredChecksComplete: true,
        materialConflict: false
      }).confidence
    ).toBe("medium");
  });

  it("drops to medium in the 70-94.99% band", () => {
    expect(
      evaluateConfidence({
        explainedPercent: 94.99,
        reconciliationPassed: true,
        requiredChecksComplete: true,
        materialConflict: false
      }).confidence
    ).toBe("medium");
    expect(
      evaluateConfidence({
        explainedPercent: 95,
        reconciliationPassed: true,
        requiredChecksComplete: true,
        materialConflict: false
      }).confidence
    ).toBe("high");
  });

  it("drops to low below 70% or on a material conflict", () => {
    expect(
      evaluateConfidence({
        explainedPercent: 69.99,
        reconciliationPassed: true,
        requiredChecksComplete: true,
        materialConflict: false
      }).confidence
    ).toBe("low");
    expect(
      evaluateConfidence({
        explainedPercent: 100,
        reconciliationPassed: true,
        requiredChecksComplete: true,
        materialConflict: true
      }).confidence
    ).toBe("low");
  });

  it("drops to medium when a non-critical source is unavailable", () => {
    expect(
      evaluateConfidence({
        explainedPercent: 100,
        reconciliationPassed: true,
        requiredChecksComplete: true,
        materialConflict: false,
        unavailableSources: 1
      }).confidence
    ).toBe("medium");
  });
});

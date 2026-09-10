import { describe, expect, it } from "vitest";
import { reconcileInvoice } from "../../src/domain/reconciliation.js";
import type { ReconciliationReport } from "../../src/domain/reconciliation.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";

/**
 * A fixed fee is authorised by a subscription, not by appearing on an invoice.
 *
 * Review showed a $100 unauthorised platform-fee increase producing "completed,
 * 100% explained, high confidence": the decomposition labelled the movement a
 * fixed-fee effect, which made it *explained*, and "explained" was standing in
 * for *valid*. Nothing read the subscriptions table at all.
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

const failed = (report: ReconciliationReport) =>
  new Set(report.checkpoints.filter((c) => !c.passed).map((c) => c.boundary));

/** Raises the platform fee on the invoice without touching its subscription. */
function inflatePlatformFee(byCents: number): Partial<Input> {
  return {
    invoiceLines: lines.map((l) =>
      l.serviceName === "Platform fee"
        ? { ...l, amountCents: l.amountCents + byCents }
        : l
    ),
    invoice: {
      ...invoice,
      subtotalCents: invoice.subtotalCents + byCents,
      totalCents: invoice.totalCents + byCents
    }
  };
}

describe("the platform fee is checked against its subscription", () => {
  it("passes when the invoice matches the subscription", () => {
    const report = run();
    const check = report.checkpoints.find(
      (c) => c.boundary === "fixed_fee_vs_subscription"
    )!;
    expect(check.scope).toBe("Platform fee");
    expect(check.expected).toBe(600_000);
    expect(check.actual).toBe(600_000);
    expect(report.status).toBe("passed");
  });

  it("fails an unauthorised fee increase that ties out arithmetically", () => {
    // This is the exact defect review demonstrated: every sum is internally
    // consistent, and the charge is still not authorised.
    const report = run(inflatePlatformFee(10_000));
    expect(report.status).toBe("failed");
    expect(failed(report)).toContain("fixed_fee_vs_subscription");

    const check = report.checkpoints.find(
      (c) => c.boundary === "fixed_fee_vs_subscription"
    )!;
    expect(check.expected).toBe(600_000);
    expect(check.actual).toBe(610_000);
    expect(check.difference).toBe(10_000);
  });

  it("fails an unauthorised fee decrease too", () => {
    expect(run(inflatePlatformFee(-5_000)).status).toBe("failed");
  });

  it("fails when the line cites a subscription that does not exist", () => {
    const report = run({
      invoiceLines: lines.map((l) =>
        l.serviceName === "Platform fee"
          ? { ...l, subscriptionId: "sub-does-not-exist" }
          : l
      )
    });
    expect(report.status).toBe("failed");
    expect(failed(report)).toContain("fixed_fee_vs_subscription");
    expect(failed(report)).toContain("subscription_active_for_period");
  });

  it("fails when an ended subscription is still being charged", () => {
    const report = run({
      subscriptions: dataset.subscriptions.map((s) => ({
        ...s,
        endedOn: "2026-07-31"
      }))
    });
    expect(report.status).toBe("failed");
    expect(failed(report)).toContain("subscription_active_for_period");
  });

  it("fails when a subscription has not started yet", () => {
    const report = run({
      subscriptions: dataset.subscriptions.map((s) => ({
        ...s,
        startedOn: "2026-09-01"
      }))
    });
    expect(report.status).toBe("failed");
    expect(failed(report)).toContain("subscription_active_for_period");
  });

  it("accepts a subscription that ended inside the period", () => {
    // Still active for part of August, so still legitimately billable here.
    const report = run({
      subscriptions: dataset.subscriptions.map((s) => ({
        ...s,
        endedOn: "2026-08-20"
      }))
    });
    expect(report.status).toBe("passed");
  });
});

describe("fixed charges with no authorising record are named, not assumed", () => {
  it("reports R2 and D1 as unverified", () => {
    // PRD §13.5 makes these illustrative flat charges with no subscription.
    // Saying so is honest; silently treating them as validated is not.
    const report = run();
    expect(report.unverifiedFixedCharges.sort()).toEqual(["D1", "R2"]);
  });

  it("does not fail the golden invoice merely for having them", () => {
    expect(run().status).toBe("passed");
  });

  it("does not list the platform fee, which is verifiable", () => {
    expect(run().unverifiedFixedCharges).not.toContain("Platform fee");
  });
});

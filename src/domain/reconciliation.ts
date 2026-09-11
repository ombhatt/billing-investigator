import {
  cents,
  sumQuantities,
  type Cents,
  type Quantity
} from "./units.js";
import { sumCents } from "./money.js";
import { periodEnd, periodStart } from "./period.js";
import { effectivePrice, rateUsage } from "./rating.js";
import type {
  DailyUsage,
  Invoice,
  InvoiceLine,
  Period,
  PriceVersion,
  RatedCharge,
  Subscription,
  UsageEvent
} from "./types.js";

/**
 * PRD §12.9 names four required boundaries. The rest are additions found in
 * review: the four alone could pass while the pipeline was demonstrably broken,
 * because the per-service loop was driven off raw usage. With no usage rows at
 * all it ran zero times and reported "passed" for an invoice with nothing
 * behind it.
 *
 * The rule this encodes: reconciliation must fail when a stage is *absent*, not
 * only when two present stages disagree.
 */
export type BoundaryName =
  // Required by PRD §12.9.
  | "raw_usage_vs_daily_aggregate"
  | "daily_aggregate_vs_rated_quantity"
  | "rated_charge_vs_invoice_line"
  | "invoice_components_vs_total"
  // Added: the stored rated charge was never itself verified.
  | "recomputed_charge_vs_rated_charge"
  | "rated_charge_internal_consistency"
  | "rated_charge_price_version"
  // Added: nothing checked that a stage existed, or that lines tied to charges.
  | "stage_coverage"
  | "invoice_line_linkage"
  | "invoice_lines_vs_subtotal"
  // Added: a fixed fee was "explained" merely by appearing on the invoice.
  | "fixed_fee_vs_subscription"
  | "subscription_active_for_period";

export interface ReconciliationCheckpoint {
  boundary: BoundaryName;
  scope: string;
  kind: "quantity" | "currency" | "structure";
  expected: number;
  actual: number;
  difference: number;
  passed: boolean;
  /** Set when a checkpoint needs more than its numbers to be understood. */
  detail?: string;
}

export interface ReconciliationReport {
  accountId: string;
  period: Period;
  invoiceId: string;
  checkpoints: ReconciliationCheckpoint[];
  totalQuantityDiscrepancy: number;
  totalDiscrepancyCents: Cents;
  /**
   * Fixed charges with no authorising record, so arithmetic consistency is all
   * that can be verified about them. R2 and D1 are illustrative flat charges in
   * this dataset (PRD §13.5) and have no subscription behind them.
   */
  unverifiedFixedCharges: string[];
  status: "passed" | "failed";
}

/**
 * Zero tolerance. PRD §12.9 is explicit that the golden scenario must not have
 * one, so a boundary passes only on an exact match.
 */
function checkpoint(
  boundary: BoundaryName,
  scope: string,
  kind: ReconciliationCheckpoint["kind"],
  expected: number,
  actual: number,
  detail?: string
): ReconciliationCheckpoint {
  const difference = actual - expected;
  return {
    boundary,
    scope,
    kind,
    expected,
    actual,
    difference,
    passed: difference === 0,
    ...(detail === undefined ? {} : { detail })
  };
}

function sumBy<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

/** The same, for quantities, so an overflowing stage total is caught here. */
function sumQuantityBy<T>(
  items: T[],
  value: (item: T) => Quantity,
  what: string
): Quantity {
  return sumQuantities(items.map(value), what);
}

/**
 * Walk raw usage through daily aggregation, rating, invoice lines and the
 * invoice total, recomputing each stage rather than trusting the stored value,
 * and requiring every stage to be present for every metered service.
 */
export function reconcileInvoice(input: {
  accountId: string;
  period: Period;
  usageEvents: UsageEvent[];
  dailyUsage: DailyUsage[];
  ratedCharges: RatedCharge[];
  prices: PriceVersion[];
  invoice: Invoice;
  invoiceLines: InvoiceLine[];
  subscriptions?: Subscription[];
}): ReconciliationReport {
  const {
    accountId,
    period,
    usageEvents,
    dailyUsage,
    ratedCharges,
    prices,
    invoice,
    invoiceLines,
    subscriptions = []
  } = input;

  const events = usageEvents.filter((e) => e.occurredAt.startsWith(period));
  const daily = dailyUsage.filter((d) => d.usageDate.startsWith(period));
  const rated = ratedCharges.filter((r) => r.period === period);
  const usageLines = invoiceLines.filter((l) => l.lineType === "usage");

  // Enumerated across every stage, not just usage. A service that appears at
  // one stage and is missing from another is exactly the defect to catch, and
  // driving the loop from usage alone made that invisible.
  const meteredServices = [
    ...new Set([
      ...events.map((e) => e.serviceName),
      ...daily.map((d) => d.serviceName),
      ...rated.map((r) => r.serviceName),
      ...usageLines.map((l) => l.serviceName)
    ])
  ].sort();

  const checkpoints: ReconciliationCheckpoint[] = [];

  for (const serviceName of meteredServices) {
    const serviceEvents = events.filter((e) => e.serviceName === serviceName);
    const serviceDaily = daily.filter((d) => d.serviceName === serviceName);
    const charge = rated.find((r) => r.serviceName === serviceName);
    const serviceLines = usageLines.filter((l) => l.serviceName === serviceName);

    // Every metered service must be represented at all four stages.
    const stagesPresent =
      (serviceEvents.length > 0 ? 1 : 0) +
      (serviceDaily.length > 0 ? 1 : 0) +
      (charge ? 1 : 0) +
      (serviceLines.length > 0 ? 1 : 0);
    checkpoints.push(
      checkpoint(
        "stage_coverage",
        serviceName,
        "structure",
        4,
        stagesPresent,
        "expects raw usage, daily aggregate, rated charge and invoice line"
      )
    );

    const rawTotal = sumBy(serviceEvents, (e) => e.quantity);
    const dailyTotal = sumQuantityBy(serviceDaily, (d) => d.quantity, "daily usage");

    checkpoints.push(
      checkpoint(
        "raw_usage_vs_daily_aggregate",
        serviceName,
        "quantity",
        rawTotal,
        dailyTotal
      )
    );

    checkpoints.push(
      checkpoint(
        "daily_aggregate_vs_rated_quantity",
        serviceName,
        "quantity",
        dailyTotal,
        charge?.consumedQuantity ?? 0
      )
    );

    // The price version the charge claims must exist and be the one in force.
    let price: PriceVersion | null = null;
    try {
      price = effectivePrice(
        prices,
        serviceName,
        periodStart(period),
        periodEnd(period)
      );
    } catch {
      price = null;
    }
    const priceMatches =
      price !== null && charge !== undefined
        ? charge.priceVersionId === price.priceVersionId
          ? 1
          : 0
        : 0;
    checkpoints.push(
      checkpoint(
        "rated_charge_price_version",
        serviceName,
        "structure",
        1,
        priceMatches,
        price === null
          ? "no single price version in force for this service and period"
          : `expects ${price.priceVersionId}`
      )
    );

    // billable = max(0, consumed - included). A stored charge that breaks its
    // own arithmetic is a pipeline defect even if the money happens to tie out.
    const expectedBillable = charge
      ? Math.max(0, charge.consumedQuantity - charge.includedQuantity)
      : 0;
    checkpoints.push(
      checkpoint(
        "rated_charge_internal_consistency",
        serviceName,
        "quantity",
        expectedBillable,
        charge?.billableQuantity ?? 0
      )
    );

    // Recomputation vs the STORED charge. The previous implementation compared
    // recomputation straight to the invoice line, so a corrupted rated charge
    // was never looked at.
    const recomputed =
      price !== null ? rateUsage(dailyTotal, price).amountCents : cents(0);
    checkpoints.push(
      checkpoint(
        "recomputed_charge_vs_rated_charge",
        serviceName,
        "currency",
        recomputed,
        charge?.amountCents ?? 0
      )
    );

    // Stored charge vs the line that bills it.
    const lineAmount = sumCents(serviceLines.map((l) => l.amountCents));
    checkpoints.push(
      checkpoint(
        "rated_charge_vs_invoice_line",
        serviceName,
        "currency",
        charge?.amountCents ?? 0,
        lineAmount
      )
    );

    // Each usage line must point at a rated charge that exists.
    const linked = serviceLines.filter(
      (l) =>
        l.ratedChargeId !== null &&
        rated.some((r) => r.ratedChargeId === l.ratedChargeId)
    ).length;
    checkpoints.push(
      checkpoint(
        "invoice_line_linkage",
        serviceName,
        "structure",
        serviceLines.length,
        linked,
        "every usage line must reference an existing rated charge"
      )
    );
  }

  // Fixed fees are authorised by a subscription, not by appearing on the
  // invoice. Without this, an unauthorised platform-fee increase reconciled
  // cleanly and was reported as fully explained.
  const unverifiedFixedCharges: string[] = [];
  for (const line of invoiceLines.filter((l) => l.lineType === "fixed")) {
    if (line.subscriptionId === null) {
      unverifiedFixedCharges.push(line.serviceName);
      continue;
    }

    const subscription = subscriptions.find(
      (s) => s.subscriptionId === line.subscriptionId
    );

    checkpoints.push(
      checkpoint(
        "fixed_fee_vs_subscription",
        line.serviceName,
        "currency",
        subscription?.monthlyFeeCents ?? 0,
        line.amountCents,
        subscription
          ? `authorised by ${subscription.subscriptionId}`
          : `no subscription ${line.subscriptionId} exists`
      )
    );

    // A subscription that had ended must not still be billing.
    const active =
      subscription !== undefined &&
      subscription.startedOn <= periodEnd(period) &&
      (subscription.endedOn === null || subscription.endedOn >= periodStart(period));
    checkpoints.push(
      checkpoint(
        "subscription_active_for_period",
        line.serviceName,
        "structure",
        1,
        active ? 1 : 0,
        subscription
          ? `effective ${subscription.startedOn} to ${subscription.endedOn ?? "open"}`
          : "subscription not found"
      )
    );
  }

  // Invoice-level arithmetic, including the subtotal the old version skipped.
  const lineTotal = sumCents(invoiceLines.map((l) => l.amountCents));
  checkpoints.push(
    checkpoint(
      "invoice_lines_vs_subtotal",
      invoice.invoiceId,
      "currency",
      lineTotal,
      invoice.subtotalCents
    )
  );

  checkpoints.push(
    checkpoint(
      "invoice_components_vs_total",
      invoice.invoiceId,
      "currency",
      invoice.subtotalCents - invoice.creditCents + invoice.taxCents,
      invoice.totalCents
    )
  );

  const totalQuantityDiscrepancy = sumBy(
    checkpoints.filter((c) => c.kind === "quantity"),
    (c) => Math.abs(c.difference)
  );
  const totalDiscrepancyCents = cents(
    sumBy(
      checkpoints.filter((c) => c.kind === "currency"),
      (c) => Math.abs(c.difference)
    ),
    "total discrepancy"
  );

  return {
    accountId,
    period,
    invoiceId: invoice.invoiceId,
    checkpoints,
    totalQuantityDiscrepancy,
    totalDiscrepancyCents,
    unverifiedFixedCharges,
    status: checkpoints.every((c) => c.passed) ? "passed" : "failed"
  };
}

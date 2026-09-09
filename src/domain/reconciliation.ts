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
  UsageEvent
} from "./types.js";

export type BoundaryName =
  | "raw_usage_vs_daily_aggregate"
  | "daily_aggregate_vs_rated_quantity"
  | "rated_charge_vs_invoice_line"
  | "invoice_components_vs_total";

export interface ReconciliationCheckpoint {
  boundary: BoundaryName;
  scope: string;
  kind: "quantity" | "currency";
  expected: number;
  actual: number;
  difference: number;
  passed: boolean;
}

export interface ReconciliationReport {
  accountId: string;
  period: Period;
  invoiceId: string;
  checkpoints: ReconciliationCheckpoint[];
  totalQuantityDiscrepancy: number;
  totalDiscrepancyCents: number;
  status: "passed" | "failed";
}

/**
 * Zero tolerance. PRD §12.9 is explicit that the golden scenario must not have
 * one, so a boundary passes only on an exact match.
 */
function checkpoint(
  boundary: BoundaryName,
  scope: string,
  kind: "quantity" | "currency",
  expected: number,
  actual: number
): ReconciliationCheckpoint {
  const difference = actual - expected;
  return { boundary, scope, kind, expected, actual, difference, passed: difference === 0 };
}

function sumBy<T>(items: T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

/**
 * Walk raw usage through daily aggregation, rating, invoice lines and the
 * invoice total, recomputing each stage rather than trusting the stored value.
 * A stored rated charge that disagrees with its own price version and quantity
 * is exactly the kind of pipeline defect this is meant to surface.
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
}): ReconciliationReport {
  const {
    accountId,
    period,
    usageEvents,
    dailyUsage,
    ratedCharges,
    prices,
    invoice,
    invoiceLines
  } = input;

  const events = usageEvents.filter((e) => e.occurredAt.startsWith(period));
  const daily = dailyUsage.filter((d) => d.usageDate.startsWith(period));
  const rated = ratedCharges.filter((r) => r.period === period);

  const services = [
    ...new Set([...events, ...daily].map((row) => row.serviceName))
  ].sort();

  const checkpoints: ReconciliationCheckpoint[] = [];

  for (const serviceName of services) {
    const rawTotal = sumBy(
      events.filter((e) => e.serviceName === serviceName),
      (e) => e.quantity
    );
    const dailyTotal = sumBy(
      daily.filter((d) => d.serviceName === serviceName),
      (d) => d.quantity
    );
    checkpoints.push(
      checkpoint(
        "raw_usage_vs_daily_aggregate",
        serviceName,
        "quantity",
        rawTotal,
        dailyTotal
      )
    );

    const charge = rated.find((r) => r.serviceName === serviceName);
    checkpoints.push(
      checkpoint(
        "daily_aggregate_vs_rated_quantity",
        serviceName,
        "quantity",
        dailyTotal,
        charge?.consumedQuantity ?? 0
      )
    );

    // Recompute the charge from its price version rather than trusting it.
    const price = effectivePrice(
      prices,
      serviceName,
      periodStart(period),
      periodEnd(period)
    );
    const recomputed = rateUsage(dailyTotal, price).amountCents;
    const lineAmount = sumCents(
      invoiceLines
        .filter((l) => l.serviceName === serviceName && l.lineType === "usage")
        .map((l) => l.amountCents)
    );
    checkpoints.push(
      checkpoint(
        "rated_charge_vs_invoice_line",
        serviceName,
        "currency",
        recomputed,
        lineAmount
      )
    );
  }

  const componentTotal =
    sumCents(invoiceLines.map((l) => l.amountCents)) -
    invoice.creditCents +
    invoice.taxCents;
  checkpoints.push(
    checkpoint(
      "invoice_components_vs_total",
      invoice.invoiceId,
      "currency",
      componentTotal,
      invoice.totalCents
    )
  );

  const totalQuantityDiscrepancy = sumBy(
    checkpoints.filter((c) => c.kind === "quantity"),
    (c) => Math.abs(c.difference)
  );
  const totalDiscrepancyCents = sumBy(
    checkpoints.filter((c) => c.kind === "currency"),
    (c) => Math.abs(c.difference)
  );

  return {
    accountId,
    period,
    invoiceId: invoice.invoiceId,
    checkpoints,
    totalQuantityDiscrepancy,
    totalDiscrepancyCents,
    status: checkpoints.every((c) => c.passed) ? "passed" : "failed"
  };
}

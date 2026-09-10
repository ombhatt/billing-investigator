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
  Subscription
} from "./types.js";

/** Sum of daily usage for one service across a period, all zones. */
export function consumedInPeriod(
  daily: DailyUsage[],
  serviceName: string,
  period: Period
): number {
  return daily
    .filter((d) => d.serviceName === serviceName && d.usageDate.startsWith(period))
    .reduce((total, d) => total + d.quantity, 0);
}

/** Services that have metered usage, in stable order. */
export function meteredServices(daily: DailyUsage[]): string[] {
  return [...new Set(daily.map((d) => d.serviceName))].sort();
}

/**
 * Rate every metered service for a period. One rated charge per service,
 * rounded to the cent before any summation. PRD §12.2.
 */
export function generateRatedCharges(
  accountId: string,
  period: Period,
  daily: DailyUsage[],
  prices: PriceVersion[]
): RatedCharge[] {
  const from = periodStart(period);
  const to = periodEnd(period);

  return meteredServices(daily).map((serviceName) => {
    const consumed = consumedInPeriod(daily, serviceName, period);
    // Shares effectivePrice rather than repeating an overlap filter: the
    // duplicate here had the same defect, accepting a version that covered only
    // part of the period.
    const rated = rateUsage(consumed, effectivePrice(prices, serviceName, from, to));

    return {
      ratedChargeId: `rc-${accountId}-${serviceName.toLowerCase().replace(/\s+/g, "-")}-${period}`,
      accountId,
      serviceName,
      period,
      consumedQuantity: rated.consumedQuantity,
      includedQuantity: rated.includedQuantity,
      billableQuantity: rated.billableQuantity,
      priceVersionId: rated.priceVersionId,
      amountCents: rated.amountCents
    };
  });
}

export interface FixedLineSource {
  serviceName: string;
  amountCents: number;
  subscriptionId: string | null;
}

/**
 * Build the invoice from rated charges plus fixed lines. The total is the sum
 * of its lines; nothing is rounded after the per-service rounding already done.
 */
export function generateInvoice(
  accountId: string,
  period: Period,
  currency: string,
  ratedCharges: RatedCharge[],
  fixedLines: FixedLineSource[],
  options: { creditCents?: number; taxCents?: number } = {}
): { invoice: Invoice; lines: InvoiceLine[] } {
  const invoiceId = `inv-${accountId}-${period}`;

  const usageLines: InvoiceLine[] = ratedCharges.map((charge) => ({
    lineId: `${invoiceId}-usage-${charge.serviceName.toLowerCase().replace(/\s+/g, "-")}`,
    invoiceId,
    accountId,
    serviceName: charge.serviceName,
    lineType: "usage",
    quantity: charge.consumedQuantity,
    amountCents: charge.amountCents,
    ratedChargeId: charge.ratedChargeId,
    subscriptionId: null
  }));

  const fixed: InvoiceLine[] = fixedLines.map((line) => ({
    lineId: `${invoiceId}-fixed-${line.serviceName.toLowerCase().replace(/\s+/g, "-")}`,
    invoiceId,
    accountId,
    serviceName: line.serviceName,
    lineType: "fixed",
    quantity: null,
    amountCents: line.amountCents,
    ratedChargeId: null,
    subscriptionId: line.subscriptionId
  }));

  const lines = [...fixed, ...usageLines];
  const subtotalCents = sumCents(lines.map((l) => l.amountCents));
  const creditCents = options.creditCents ?? 0;
  const taxCents = options.taxCents ?? 0;

  const invoice: Invoice = {
    invoiceId,
    accountId,
    period,
    status: "finalized",
    currency,
    subtotalCents,
    creditCents,
    taxCents,
    totalCents: subtotalCents - creditCents + taxCents,
    issuedOn: nextMonthFirstDay(period)
  };

  return { invoice, lines };
}

export function subscriptionFixedLine(
  subscription: Subscription
): FixedLineSource {
  return {
    serviceName: "Platform fee",
    amountCents: subscription.monthlyFeeCents,
    subscriptionId: subscription.subscriptionId
  };
}

function nextMonthFirstDay(period: Period): string {
  const [year, month] = period.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  return next.toISOString().slice(0, 10);
}

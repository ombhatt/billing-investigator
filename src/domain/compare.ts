import { percentageChange, sumCents, toOneDecimal } from "./money.js";
import type { Invoice, InvoiceLine } from "./types.js";

export interface ServiceComparison {
  serviceName: string;
  currentCents: number;
  comparisonCents: number;
  varianceCents: number;
}

export interface InvoiceComparison {
  currentInvoiceId: string;
  comparisonInvoiceId: string;
  currentPeriod: string;
  comparisonPeriod: string;
  currency: string;
  currentTotalCents: number;
  comparisonTotalCents: number;
  varianceCents: number;
  /** Null when the comparison total is zero. PRD §12.4. */
  percentageVariance: number | null;
  percentageVarianceDisplay: number | null;
  services: ServiceComparison[];
  /** Services with a non-zero variance, largest absolute movement first. */
  rankedDrivers: ServiceComparison[];
  /** Sum of the per-service variances; equals varianceCents when lines tie out. */
  explainedCents: number;
}

function amountFor(lines: InvoiceLine[], serviceName: string): number {
  return sumCents(
    lines.filter((l) => l.serviceName === serviceName).map((l) => l.amountCents)
  );
}

export function compareInvoices(
  current: { invoice: Invoice; lines: InvoiceLine[] },
  comparison: { invoice: Invoice; lines: InvoiceLine[] }
): InvoiceComparison {
  const serviceNames = [
    ...new Set([
      ...current.lines.map((l) => l.serviceName),
      ...comparison.lines.map((l) => l.serviceName)
    ])
  ].sort();

  const services: ServiceComparison[] = serviceNames.map((serviceName) => {
    const currentCents = amountFor(current.lines, serviceName);
    const comparisonCents = amountFor(comparison.lines, serviceName);
    return {
      serviceName,
      currentCents,
      comparisonCents,
      varianceCents: currentCents - comparisonCents
    };
  });

  const varianceCents =
    current.invoice.totalCents - comparison.invoice.totalCents;
  const percentage = percentageChange(
    current.invoice.totalCents,
    comparison.invoice.totalCents
  );

  return {
    currentInvoiceId: current.invoice.invoiceId,
    comparisonInvoiceId: comparison.invoice.invoiceId,
    currentPeriod: current.invoice.period,
    comparisonPeriod: comparison.invoice.period,
    currency: current.invoice.currency,
    currentTotalCents: current.invoice.totalCents,
    comparisonTotalCents: comparison.invoice.totalCents,
    varianceCents,
    percentageVariance: percentage,
    percentageVarianceDisplay: percentage === null ? null : toOneDecimal(percentage),
    services,
    rankedDrivers: services
      .filter((s) => s.varianceCents !== 0)
      .sort((a, b) => Math.abs(b.varianceCents) - Math.abs(a.varianceCents)),
    explainedCents: sumCents(services.map((s) => s.varianceCents))
  };
}

import {
  addCents,
  cents,
  subtractCents,
  type Cents,
  type Quantity
} from "./units.js";
import { sumCents } from "./money.js";
import { periodEnd, periodStart } from "./period.js";
import { consumedInPeriod } from "./invoice.js";
import { costOf, effectivePrice } from "./rating.js";
import type {
  DailyUsage,
  Invoice,
  InvoiceLine,
  Period,
  PriceVersion
} from "./types.js";

export interface ServiceEffects {
  serviceName: string;
  /** Metered services carry volume and price effects; fixed lines do not. */
  volumeEffectCents: Cents;
  priceEffectCents: Cents;
  fixedFeeEffectCents: Cents;
  totalEffectCents: Cents;
  currentQuantity: Quantity | null;
  comparisonQuantity: Quantity | null;
  priceVersionIds: string[];
}

export interface VarianceDecomposition {
  services: ServiceEffects[];
  volumeEffectCents: Cents;
  priceEffectCents: Cents;
  fixedFeeEffectCents: Cents;
  creditEffectCents: Cents;
  taxEffectCents: Cents;
  totalEffectCents: Cents;
  invoiceVarianceCents: Cents;
  unexplainedCents: Cents;
  /** Clamped to [0, 100]. PRD §12.5. */
  explainedPercent: number;
  priceVersionIds: string[];
}

/** PRD §12.5, clamped. A zero variance with zero unexplained is fully explained. */
export function explainedPercent(
  unexplainedCents: number,
  invoiceVarianceCents: number
): number {
  if (invoiceVarianceCents === 0) {
    return unexplainedCents === 0 ? 100 : 0;
  }
  const raw =
    100 * (1 - Math.abs(unexplainedCents) / Math.abs(invoiceVarianceCents));
  return Math.min(100, Math.max(0, raw));
}

function fixedAmount(lines: InvoiceLine[], serviceName: string): Cents {
  return sumCents(
    lines
      .filter((l) => l.serviceName === serviceName && l.lineType === "fixed")
      .map((l) => l.amountCents)
  );
}

/**
 * Separate the invoice variance into consumption, price, fixed-fee, credit and
 * tax effects. PRD §12.4 counterfactuals:
 *
 *   volume_effect = cost(current_qty, previous_price) - cost(previous_qty, previous_price)
 *   price_effect  = cost(current_qty, current_price)  - cost(current_qty, previous_price)
 *
 * Holding the price constant for the volume term and the quantity constant for
 * the price term means the two always sum to the service's total movement, even
 * if pricing later becomes non-linear.
 */
export function decomposeVariance(input: {
  currentPeriod: Period;
  comparisonPeriod: Period;
  daily: DailyUsage[];
  prices: PriceVersion[];
  current: { invoice: Invoice; lines: InvoiceLine[] };
  comparison: { invoice: Invoice; lines: InvoiceLine[] };
}): VarianceDecomposition {
  const { currentPeriod, comparisonPeriod, daily, prices, current, comparison } =
    input;

  const meteredNames = [
    ...new Set(
      [...current.lines, ...comparison.lines]
        .filter((l) => l.lineType === "usage")
        .map((l) => l.serviceName)
    )
  ].sort();

  const fixedNames = [
    ...new Set(
      [...current.lines, ...comparison.lines]
        .filter((l) => l.lineType === "fixed")
        .map((l) => l.serviceName)
    )
  ].sort();

  const services: ServiceEffects[] = [];
  const priceVersionIds = new Set<string>();

  for (const serviceName of meteredNames) {
    const currentQuantity = consumedInPeriod(daily, serviceName, currentPeriod);
    const comparisonQuantity = consumedInPeriod(
      daily,
      serviceName,
      comparisonPeriod
    );

    const currentPrice = effectivePrice(
      prices,
      serviceName,
      periodStart(currentPeriod),
      periodEnd(currentPeriod)
    );
    const comparisonPrice = effectivePrice(
      prices,
      serviceName,
      periodStart(comparisonPeriod),
      periodEnd(comparisonPeriod)
    );
    priceVersionIds.add(currentPrice.priceVersionId);
    priceVersionIds.add(comparisonPrice.priceVersionId);

    // Counterfactual decomposition, PRD §12.4: hold price still to isolate
    // volume, then hold volume still to isolate price.
    const volumeEffectCents = subtractCents(
      costOf(currentQuantity, comparisonPrice),
      costOf(comparisonQuantity, comparisonPrice),
      "volume effect"
    );
    const priceEffectCents = subtractCents(
      costOf(currentQuantity, currentPrice),
      costOf(currentQuantity, comparisonPrice),
      "price effect"
    );

    services.push({
      serviceName,
      volumeEffectCents,
      priceEffectCents,
      fixedFeeEffectCents: cents(0),
      totalEffectCents: addCents(volumeEffectCents, priceEffectCents, "total effect"),
      currentQuantity,
      comparisonQuantity,
      priceVersionIds: [
        ...new Set([currentPrice.priceVersionId, comparisonPrice.priceVersionId])
      ]
    });
  }

  for (const serviceName of fixedNames) {
    const fixedFeeEffectCents = subtractCents(
      fixedAmount(current.lines, serviceName),
      fixedAmount(comparison.lines, serviceName),
      "fixed fee effect"
    );
    services.push({
      serviceName,
      volumeEffectCents: cents(0),
      priceEffectCents: cents(0),
      fixedFeeEffectCents,
      totalEffectCents: fixedFeeEffectCents,
      currentQuantity: null,
      comparisonQuantity: null,
      priceVersionIds: []
    });
  }

  services.sort((a, b) => a.serviceName.localeCompare(b.serviceName));

  const volumeEffectCents = sumCents(services.map((s) => s.volumeEffectCents));
  const priceEffectCents = sumCents(services.map((s) => s.priceEffectCents));
  const fixedFeeEffectCents = sumCents(
    services.map((s) => s.fixedFeeEffectCents)
  );

  // A larger credit reduces the invoice, so its effect carries the opposite
  // sign. Subtracting in this order rather than negating avoids producing -0,
  // which would survive into JSON output and test comparisons.
  const creditEffectCents = subtractCents(
    comparison.invoice.creditCents,
    current.invoice.creditCents,
    "credit effect"
  );
  const taxEffectCents = subtractCents(
    current.invoice.taxCents,
    comparison.invoice.taxCents,
    "tax effect"
  );

  const totalEffectCents = sumCents(
    [
      volumeEffectCents,
      priceEffectCents,
      fixedFeeEffectCents,
      creditEffectCents,
      taxEffectCents
    ],
    "total effect"
  );

  const invoiceVarianceCents = subtractCents(
    current.invoice.totalCents,
    comparison.invoice.totalCents,
    "invoice variance"
  );
  const unexplainedCents = subtractCents(
    invoiceVarianceCents,
    totalEffectCents,
    "unexplained variance"
  );

  return {
    services,
    volumeEffectCents,
    priceEffectCents,
    fixedFeeEffectCents,
    creditEffectCents,
    taxEffectCents,
    totalEffectCents,
    invoiceVarianceCents,
    unexplainedCents,
    explainedPercent: explainedPercent(unexplainedCents, invoiceVarianceCents),
    priceVersionIds: [...priceVersionIds].sort()
  };
}

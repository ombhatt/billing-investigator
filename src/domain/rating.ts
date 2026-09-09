import { rateCents } from "./money.js";
import type { IsoDate, PriceVersion } from "./types.js";

export interface RatingResult {
  consumedQuantity: number;
  includedQuantity: number;
  billableQuantity: number;
  priceVersionId: string;
  amountCents: number;
}

/**
 * PRD §12.3:
 *   billable_quantity = max(0, consumed_quantity - included_quantity)
 *   usage_charge_cents = rate(billable_quantity, effective_price_version)
 */
export function rateUsage(
  consumedQuantity: number,
  price: PriceVersion
): RatingResult {
  const billableQuantity = Math.max(0, consumedQuantity - price.includedQuantity);
  const usageCents = rateCents(
    billableQuantity,
    price.overageRateCents,
    price.unitDivisor
  );

  return {
    consumedQuantity,
    includedQuantity: price.includedQuantity,
    billableQuantity,
    priceVersionId: price.priceVersionId,
    amountCents: price.fixedFeeCents + usageCents
  };
}

/** Counterfactual cost used by variance decomposition. PRD §12.4. */
export function costOf(quantity: number, price: PriceVersion): number {
  return rateUsage(quantity, price).amountCents;
}

function overlaps(price: PriceVersion, from: IsoDate, to: IsoDate): boolean {
  const startsBeforeEnd = price.effectiveFrom <= to;
  const endsAfterStart = price.effectiveTo === null || price.effectiveTo >= from;
  return startsBeforeEnd && endsAfterStart;
}

/** Every price version for a service overlapping the window. PRD §11.5. */
export function priceVersionsOverlapping(
  prices: PriceVersion[],
  serviceName: string,
  from: IsoDate,
  to: IsoDate
): PriceVersion[] {
  return prices
    .filter((p) => p.serviceName === serviceName && overlaps(p, from, to))
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/**
 * The single price version in force for a service across a window.
 * Throws when the window straddles a price change, since P0 rating assumes one
 * effective version per period and silently picking one would be wrong.
 */
export function effectivePrice(
  prices: PriceVersion[],
  serviceName: string,
  from: IsoDate,
  to: IsoDate
): PriceVersion {
  const matches = priceVersionsOverlapping(prices, serviceName, from, to);
  if (matches.length === 0) {
    throw new Error(`no price version for ${serviceName} over ${from}..${to}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${matches.length} price versions for ${serviceName} over ${from}..${to}; P0 rates one version per period`
    );
  }
  return matches[0];
}

/** True when more than one version is in force across the window. PRD §11.5. */
export function priceChanged(
  prices: PriceVersion[],
  serviceName: string,
  from: IsoDate,
  to: IsoDate
): boolean {
  return priceVersionsOverlapping(prices, serviceName, from, to).length > 1;
}

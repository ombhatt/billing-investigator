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
 * True when a version is in force for the whole window, not merely part of it.
 *
 * Overlap is not coverage. Review showed a version effective from August 14
 * being used to rate August 1-31: it overlapped the month, so it was selected,
 * and the first thirteen days were priced by a contract that did not yet apply.
 */
export function covers(price: PriceVersion, from: IsoDate, to: IsoDate): boolean {
  const startedInTime = price.effectiveFrom <= from;
  const stillInForce = price.effectiveTo === null || price.effectiveTo >= to;
  return startedInTime && stillInForce;
}

/**
 * The single price version in force across the whole window.
 *
 * Throws when the window straddles a price change, since P0 rates one version
 * per period, and equally when the sole candidate leaves any of the window
 * uncovered — a partial contract cannot price a full month.
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
  const only = matches[0];
  if (!covers(only, from, to)) {
    throw new Error(
      `price version ${only.priceVersionId} covers ${only.effectiveFrom}..${only.effectiveTo ?? "open"}, ` +
        `which does not span ${from}..${to} for ${serviceName}`
    );
  }
  return only;
}

/** Any part of the window with no price version in force. */
export function coverageGap(
  prices: PriceVersion[],
  serviceName: string,
  from: IsoDate,
  to: IsoDate
): boolean {
  const matches = priceVersionsOverlapping(prices, serviceName, from, to);
  if (matches.length === 0) return true;
  // P0 rates one version per period, so a single covering version is the only
  // shape that leaves no gap. Multiple versions are reported as a price change
  // rather than a gap.
  return matches.length === 1 && !covers(matches[0], from, to);
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

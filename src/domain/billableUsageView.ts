import { billingPeriod, cents, quantity } from "./units.js";
import { periodEnd, periodOf, periodStart } from "./period.js";
import type { DailyUsage, PriceVersion, Zone } from "./types.js";
import { rateUsage } from "./rating.js";

/**
 * A record shaped like a public billable-usage row. PRD §13.9.
 *
 * This exists to mark the integration boundary: in production these fields
 * would come from a real billing API, and only this adapter would change.
 * It never makes a network call.
 */
export interface BillableUsageRecord {
  BillingCurrency: string;
  BillingPeriodStart: string;
  ChargePeriodStart: string;
  ChargePeriodEnd: string;
  ServiceName: string;
  ServiceFamilyName: string;
  ConsumedQuantity: number;
  ConsumedUnit: string;
  PricingQuantity: number;
  ContractedCost: number;
  CumulatedContractedCost: number;
  ZoneId: string;
  ZoneName: string;
}

/**
 * `ContractedCost` and `CumulatedContractedCost` are dollars, matching the
 * public shape. Cents stay authoritative everywhere upstream; this is a
 * presentation boundary. PRD §12.1.
 */
export function toBillableUsageRecords(
  daily: DailyUsage[],
  zones: Zone[],
  prices: PriceVersion[],
  currency: string
): BillableUsageRecord[] {
  const zoneNames = new Map(zones.map((z) => [z.zoneId, z.zoneName]));
  const rows = [...daily].sort(
    (a, b) =>
      a.usageDate.localeCompare(b.usageDate) ||
      a.serviceName.localeCompare(b.serviceName) ||
      a.zoneId.localeCompare(b.zoneId)
  );

  const cumulativeByService = new Map<string, number>();
  const records: BillableUsageRecord[] = [];

  for (const row of rows) {
    const price = prices.find(
      (p) =>
        p.serviceName === row.serviceName &&
        p.effectiveFrom <= row.usageDate &&
        (p.effectiveTo === null || p.effectiveTo >= row.usageDate)
    );
    if (!price) continue;

    // Daily rows are priced at the marginal overage rate: monthly allowances
    // only make sense once the whole period is rated, so no inclusion is
    // applied here.
    const dailyCostCents = rateUsage(row.quantity, {
      ...price,
      includedQuantity: quantity(0),
      fixedFeeCents: cents(0)
    }).amountCents;

    const key = `${row.serviceName}|${periodOf(row.usageDate)}`;
    const cumulative = (cumulativeByService.get(key) ?? 0) + dailyCostCents;
    cumulativeByService.set(key, cumulative);

    const period = periodOf(row.usageDate);
    records.push({
      BillingCurrency: currency,
      BillingPeriodStart: `${periodStart(period)}T00:00:00Z`,
      ChargePeriodStart: `${row.usageDate}T00:00:00Z`,
      ChargePeriodEnd: `${row.usageDate}T23:59:59Z`,
      ServiceName: row.serviceName,
      ServiceFamilyName: price.serviceFamily,
      ConsumedQuantity: row.quantity,
      ConsumedUnit: row.unit,
      PricingQuantity: row.quantity / price.unitDivisor,
      ContractedCost: dailyCostCents / 100,
      CumulatedContractedCost: cumulative / 100,
      ZoneId: row.zoneId,
      ZoneName: zoneNames.get(row.zoneId) ?? row.zoneId
    });
  }

  return records;
}

/** Convenience for the period a record set covers. */
export function billingPeriodBounds(period: string): {
  start: string;
  end: string;
} {
  return {
    start: `${periodStart(billingPeriod(period))}T00:00:00Z`,
    end: `${periodEnd(billingPeriod(period))}T23:59:59Z`
  };
}

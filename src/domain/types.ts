/**
 * Storage-agnostic shapes the domain operates on. Nothing here imports D1 or
 * any Cloudflare binding, so every calculation is testable in plain Node.
 */

export type { BillingPeriod, Cents, IsoDate, Quantity } from "./units.js";
import type { BillingPeriod, Cents, IsoDate, Quantity } from "./units.js";

/** Kept as an alias of the branded month for readability at call sites. */
export type Period = BillingPeriod;
export type IsoTimestamp = string; // "2026-08-14T10:20:00Z"

export interface Account {
  accountId: string;
  displayName: string;
  planType: string;
  currency: string;
  taxStatus: string;
  primaryZoneId: string;
  primaryZoneName: string;
}

export interface Zone {
  zoneId: string;
  accountId: string;
  zoneName: string;
}

export interface Subscription {
  subscriptionId: string;
  accountId: string;
  planName: string;
  monthlyFeeCents: Cents;
  startedOn: IsoDate;
  endedOn: IsoDate | null;
}

/**
 * Fixed fee plus one linear overage tier. PRD §12.3 permits exactly this for
 * P0; the schema keeps room for more tiers without the engine computing them.
 */
export interface PriceVersion {
  priceVersionId: string;
  accountId: string;
  serviceName: string;
  serviceFamily: string;
  includedQuantity: Quantity;
  /** Cents charged per `unitDivisor` billable units. */
  overageRateCents: Cents;
  unitDivisor: number;
  unit: string;
  fixedFeeCents: Cents;
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
}

export interface UsageEvent {
  eventId: string;
  accountId: string;
  serviceName: string;
  zoneId: string;
  sourceEventKey: string;
  occurredAt: IsoTimestamp;
  quantity: Quantity;
  unit: string;
}

export interface DailyUsage {
  accountId: string;
  serviceName: string;
  zoneId: string;
  usageDate: IsoDate;
  quantity: Quantity;
  unit: string;
  /** Lineage back to the events this row aggregates. PRD §14. */
  sourceEventCount: number;
  sourceEventFirst: IsoTimestamp;
  sourceEventLast: IsoTimestamp;
}

export interface RatedCharge {
  ratedChargeId: string;
  accountId: string;
  serviceName: string;
  period: Period;
  consumedQuantity: Quantity;
  includedQuantity: Quantity;
  billableQuantity: Quantity;
  priceVersionId: string;
  amountCents: Cents;
}

export type InvoiceLineType = "fixed" | "usage";

export interface InvoiceLine {
  lineId: string;
  invoiceId: string;
  accountId: string;
  serviceName: string;
  lineType: InvoiceLineType;
  quantity: Quantity | null;
  amountCents: Cents;
  ratedChargeId: string | null;
  subscriptionId: string | null;
}

export interface Invoice {
  invoiceId: string;
  accountId: string;
  period: Period;
  status: string;
  currency: string;
  subtotalCents: Cents;
  creditCents: Cents;
  taxCents: Cents;
  totalCents: Cents;
  issuedOn: IsoDate;
}

export type AccountEventType =
  | "deployment"
  | "configuration_change"
  | "subscription_change"
  | "entitlement_change"
  | "credit";

export interface AccountEvent {
  eventId: string;
  accountId: string;
  eventType: AccountEventType;
  name: string;
  zoneId: string | null;
  occurredAt: IsoTimestamp;
  metadata: string;
}

/** Everything the generator produces and the domain consumes. */
export interface BillingDataset {
  account: Account;
  zones: Zone[];
  subscriptions: Subscription[];
  priceVersions: PriceVersion[];
  usageEvents: UsageEvent[];
  dailyUsage: DailyUsage[];
  ratedCharges: RatedCharge[];
  invoices: Invoice[];
  invoiceLines: InvoiceLine[];
  accountEvents: AccountEvent[];
}

/**
 * Storage-agnostic shapes the domain operates on. Nothing here imports D1 or
 * any Cloudflare binding, so every calculation is testable in plain Node.
 */

export type Period = string; // "2026-08"
export type IsoDate = string; // "2026-08-14"
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
  monthlyFeeCents: number;
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
  includedQuantity: number;
  /** Cents charged per `unitDivisor` billable units. */
  overageRateCents: number;
  unitDivisor: number;
  unit: string;
  fixedFeeCents: number;
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
  quantity: number;
  unit: string;
}

export interface DailyUsage {
  accountId: string;
  serviceName: string;
  zoneId: string;
  usageDate: IsoDate;
  quantity: number;
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
  consumedQuantity: number;
  includedQuantity: number;
  billableQuantity: number;
  priceVersionId: string;
  amountCents: number;
}

export type InvoiceLineType = "fixed" | "usage";

export interface InvoiceLine {
  lineId: string;
  invoiceId: string;
  accountId: string;
  serviceName: string;
  lineType: InvoiceLineType;
  quantity: number | null;
  amountCents: number;
  ratedChargeId: string | null;
  subscriptionId: string | null;
}

export interface Invoice {
  invoiceId: string;
  accountId: string;
  period: Period;
  status: string;
  currency: string;
  subtotalCents: number;
  creditCents: number;
  taxCents: number;
  totalCents: number;
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

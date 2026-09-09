import {
  generateInvoice,
  generateRatedCharges,
  subscriptionFixedLine,
  type FixedLineSource
} from "../src/domain/invoice.js";
import { isWeekend, periodDates } from "../src/domain/period.js";
import type {
  AccountEvent,
  BillingDataset,
  DailyUsage,
  Invoice,
  InvoiceLine,
  PriceVersion,
  RatedCharge,
  Subscription,
  UsageEvent
} from "../src/domain/types.js";
import { intBetween, mulberry32 } from "./prng.js";
import {
  ACCOUNT,
  CHANGE_DATE,
  CHANGE_HOUR_UTC,
  D1_CENTS,
  DAY_JITTER,
  DEPLOYMENT_EVENT,
  DIURNAL_WEIGHTS,
  EVENT_MINUTE_UTC,
  PERIODS,
  PLATFORM_FEE_CENTS,
  R2_CENTS,
  SECONDARY_ZONE,
  SEED,
  SERVICE_WORKERS,
  SERVICE_WORKERS_AI,
  SUBSCRIPTION_ID,
  WEEKDAY_WEIGHT,
  WEEKEND_WEIGHT,
  WORKERS_AI_ELEVATION_PERCENT,
  WORKERS_AI_PRICE,
  WORKERS_AI_QUANTITY,
  WORKERS_PRICE,
  WORKERS_QUANTITY,
  ZONE_ELEVATION_PERCENT,
  ZONE_SHARE
} from "./constants.js";

interface Slot {
  date: string;
  zoneId: string;
  hour: number;
  weight: number;
}

function isElevated(date: string, hour: number): boolean {
  if (date < CHANGE_DATE) return false;
  if (date > CHANGE_DATE) return true;
  return hour >= CHANGE_HOUR_UTC;
}

function timestampFor(date: string, hour: number): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(EVENT_MINUTE_UTC).padStart(2, "0");
  return `${date}T${hh}:${mm}:00Z`;
}

/**
 * Distribute `target` across slots proportionally to their weights, giving the
 * remainder to the final slot. This is what makes a month hit its total to the
 * unit no matter how the shape changes. PRD §13.6.
 */
function distribute(target: number, slots: Slot[]): number[] {
  const totalWeight = slots.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight <= 0) throw new Error("total weight must be positive");

  const quantities: number[] = [];
  let allocated = 0;
  for (let i = 0; i < slots.length - 1; i++) {
    // BigInt because target * weight overflows the safe integer range.
    const q = Number(
      (BigInt(target) * BigInt(slots[i].weight)) / BigInt(totalWeight)
    );
    quantities.push(q);
    allocated += q;
  }
  const last = target - allocated;
  if (last <= 0) throw new Error("final slot must stay positive");
  quantities.push(last);
  return quantities;
}

function dayWeights(period: string, random: () => number): Map<string, number> {
  const weights = new Map<string, number>();
  for (const date of periodDates(period)) {
    const base = isWeekend(date) ? WEEKEND_WEIGHT : WEEKDAY_WEIGHT;
    weights.set(date, base + intBetween(random, -DAY_JITTER, DAY_JITTER));
  }
  return weights;
}

function workersSlots(period: string, random: () => number): Slot[] {
  const perDay = dayWeights(period, random);
  const slots: Slot[] = [];
  for (const date of periodDates(period)) {
    const dayWeight = perDay.get(date)!;
    for (const zoneId of [ACCOUNT.primaryZoneId, SECONDARY_ZONE.zoneId]) {
      const share = ZONE_SHARE[zoneId as keyof typeof ZONE_SHARE];
      const elevation =
        ZONE_ELEVATION_PERCENT[zoneId as keyof typeof ZONE_ELEVATION_PERCENT];
      for (let hour = 0; hour < 24; hour++) {
        const percent = isElevated(date, hour) ? elevation : 100;
        slots.push({
          date,
          zoneId,
          hour,
          weight: dayWeight * share * DIURNAL_WEIGHTS[hour] * percent
        });
      }
    }
  }
  return slots;
}

function workersAiSlots(period: string, random: () => number): Slot[] {
  const perDay = dayWeights(period, random);
  return periodDates(period).map((date) => {
    const percent = isElevated(date, 12) ? WORKERS_AI_ELEVATION_PERCENT : 100;
    return {
      date,
      zoneId: ACCOUNT.primaryZoneId,
      hour: 12,
      weight: perDay.get(date)! * percent
    };
  });
}

function buildEvents(
  serviceName: string,
  idPrefix: string,
  unit: string,
  slots: Slot[],
  quantities: number[]
): UsageEvent[] {
  return slots.map((slot, index) => ({
    eventId: `${idPrefix}-${slot.date}-${slot.zoneId}-${String(slot.hour).padStart(2, "0")}`,
    accountId: ACCOUNT.accountId,
    serviceName,
    zoneId: slot.zoneId,
    // Unique per event, so no two events can share a fingerprint. PRD §12.6.
    sourceEventKey: `${slot.zoneId}:${slot.date}:${String(slot.hour).padStart(2, "0")}`,
    occurredAt: timestampFor(slot.date, slot.hour),
    quantity: quantities[index],
    unit
  }));
}

/** Roll events up to one row per service, zone and day, carrying lineage. */
function aggregateDaily(events: UsageEvent[]): DailyUsage[] {
  const groups = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const date = event.occurredAt.slice(0, 10);
    const key = `${event.serviceName}|${event.zoneId}|${date}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(event);
    else groups.set(key, [event]);
  }

  const rows: DailyUsage[] = [];
  for (const [key, group] of groups) {
    const [serviceName, zoneId, usageDate] = key.split("|");
    const ordered = [...group].sort((a, b) =>
      a.occurredAt.localeCompare(b.occurredAt)
    );
    rows.push({
      accountId: ACCOUNT.accountId,
      serviceName,
      zoneId,
      usageDate,
      quantity: ordered.reduce((total, e) => total + e.quantity, 0),
      unit: ordered[0].unit,
      sourceEventCount: ordered.length,
      sourceEventFirst: ordered[0].occurredAt,
      sourceEventLast: ordered[ordered.length - 1].occurredAt
    });
  }

  return rows.sort(
    (a, b) =>
      a.usageDate.localeCompare(b.usageDate) ||
      a.serviceName.localeCompare(b.serviceName) ||
      a.zoneId.localeCompare(b.zoneId)
  );
}

/**
 * Deterministic: the same seed always produces byte-identical output.
 * PRD §13.6, §15.3.
 */
export function generateSyntheticData(seed: number = SEED): BillingDataset {
  const random = mulberry32(seed);

  const priceVersions: PriceVersion[] = [
    { ...WORKERS_PRICE, accountId: ACCOUNT.accountId },
    { ...WORKERS_AI_PRICE, accountId: ACCOUNT.accountId }
  ];

  const subscriptions: Subscription[] = [
    {
      subscriptionId: SUBSCRIPTION_ID,
      accountId: ACCOUNT.accountId,
      planName: ACCOUNT.planType,
      monthlyFeeCents: PLATFORM_FEE_CENTS,
      startedOn: "2026-01-01",
      endedOn: null
    }
  ];

  const usageEvents: UsageEvent[] = [];
  for (const period of PERIODS) {
    const wSlots = workersSlots(period, random);
    usageEvents.push(
      ...buildEvents(
        SERVICE_WORKERS,
        "ue-workers",
        WORKERS_PRICE.unit,
        wSlots,
        distribute(WORKERS_QUANTITY[period], wSlots)
      )
    );

    const aiSlots = workersAiSlots(period, random);
    usageEvents.push(
      ...buildEvents(
        SERVICE_WORKERS_AI,
        "ue-workersai",
        WORKERS_AI_PRICE.unit,
        aiSlots,
        distribute(WORKERS_AI_QUANTITY[period], aiSlots)
      )
    );
  }
  usageEvents.sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)
  );

  const dailyUsage = aggregateDaily(usageEvents);

  const fixedLines: FixedLineSource[] = [
    subscriptionFixedLine(subscriptions[0]),
    { serviceName: "R2", amountCents: R2_CENTS, subscriptionId: null },
    { serviceName: "D1", amountCents: D1_CENTS, subscriptionId: null }
  ];

  const ratedCharges: RatedCharge[] = [];
  const invoices: Invoice[] = [];
  const invoiceLines: InvoiceLine[] = [];

  for (const period of PERIODS) {
    const charges = generateRatedCharges(
      ACCOUNT.accountId,
      period,
      dailyUsage,
      priceVersions
    );
    ratedCharges.push(...charges);

    const { invoice, lines } = generateInvoice(
      ACCOUNT.accountId,
      period,
      ACCOUNT.currency,
      charges,
      fixedLines
    );
    invoices.push(invoice);
    invoiceLines.push(...lines);
  }

  const accountEvents: AccountEvent[] = [
    {
      eventId: "dep-1790",
      accountId: ACCOUNT.accountId,
      eventType: "deployment",
      name: "api-gateway-v2",
      zoneId: ACCOUNT.primaryZoneId,
      occurredAt: "2026-07-02T11:15:00Z",
      metadata: "synthetic deployment record"
    },
    {
      eventId: DEPLOYMENT_EVENT.eventId,
      accountId: ACCOUNT.accountId,
      eventType: "deployment",
      name: DEPLOYMENT_EVENT.name,
      zoneId: DEPLOYMENT_EVENT.zoneId,
      occurredAt: DEPLOYMENT_EVENT.occurredAt,
      metadata: "synthetic deployment record"
    },
    {
      eventId: "cfg-311",
      accountId: ACCOUNT.accountId,
      eventType: "configuration_change",
      name: "cache-rules-update",
      zoneId: ACCOUNT.primaryZoneId,
      occurredAt: "2026-08-14T22:40:00Z",
      metadata: "synthetic configuration record"
    }
  ];

  return {
    account: { ...ACCOUNT },
    zones: [
      {
        zoneId: ACCOUNT.primaryZoneId,
        accountId: ACCOUNT.accountId,
        zoneName: ACCOUNT.primaryZoneName
      },
      {
        zoneId: SECONDARY_ZONE.zoneId,
        accountId: ACCOUNT.accountId,
        zoneName: SECONDARY_ZONE.zoneName
      }
    ],
    subscriptions,
    priceVersions,
    usageEvents,
    dailyUsage,
    ratedCharges,
    invoices,
    invoiceLines,
    accountEvents
  };
}

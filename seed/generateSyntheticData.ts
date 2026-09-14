import {
  isoDate,
  quantity,
  sumQuantities,
  type BillingPeriod,
  type Quantity
} from "../src/domain/units.js";
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
  DAY_JITTER,
  DIURNAL_WEIGHTS,
  EVENT_MINUTE_UTC,
  GOLDEN_ACCOUNT,
  WEEKDAY_WEIGHT,
  WEEKEND_WEIGHT,
  type AccountProfile
} from "./constants.js";

interface Slot {
  date: string;
  zoneId: string;
  hour: number;
  weight: number;
}

function isElevated(profile: AccountProfile, date: string, hour: number): boolean {
  if (date < profile.changeDate) return false;
  if (date > profile.changeDate) return true;
  return hour >= profile.changeHourUtc;
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
function distribute(target: number, slots: Slot[]): Quantity[] {
  const totalWeight = slots.reduce((sum, s) => sum + s.weight, 0);
  if (totalWeight <= 0) throw new Error("total weight must be positive");

  const quantities: Quantity[] = [];
  let allocated = 0;
  for (let i = 0; i < slots.length - 1; i++) {
    // BigInt because target * weight overflows the safe integer range.
    const q = Number(
      (BigInt(target) * BigInt(slots[i].weight)) / BigInt(totalWeight)
    );
    quantities.push(quantity(q, "distributed slot"));
    allocated += q;
  }
  const last = target - allocated;
  if (last <= 0) throw new Error("final slot must stay positive");
  quantities.push(quantity(last, "final slot"));
  return quantities;
}


function dayWeights(period: BillingPeriod, random: () => number): Map<string, number> {
  const weights = new Map<string, number>();
  for (const date of periodDates(period)) {
    const base = isWeekend(date) ? WEEKEND_WEIGHT : WEEKDAY_WEIGHT;
    weights.set(date, base + intBetween(random, -DAY_JITTER, DAY_JITTER));
  }
  return weights;
}

/** Hourly, across both zones, weighted by the diurnal curve. */
function workersSlots(
  profile: AccountProfile,
  period: BillingPeriod,
  random: () => number
): Slot[] {
  const perDay = dayWeights(period, random);
  const slots: Slot[] = [];
  for (const date of periodDates(period)) {
    const dayWeight = perDay.get(date)!;
    for (const zoneId of [
      profile.account.primaryZoneId,
      profile.secondaryZone.zoneId
    ]) {
      const share = profile.zoneShare[zoneId];
      const elevation = profile.workers.elevationPercentByZone[zoneId];
      for (let hour = 0; hour < 24; hour++) {
        const percent = isElevated(profile, date, hour) ? elevation : 100;
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

/**
 * One slot a day at noon, primary zone only.
 *
 * Deliberately not folded into `workersSlots`: this shape carries neither the
 * zone share nor the diurnal weight, and unifying the two would rely on those
 * factors cancelling in `distribute`. Relying on a cancellation is how seeded
 * bytes move.
 */
function workersAiSlots(
  profile: AccountProfile,
  period: BillingPeriod,
  random: () => number
): Slot[] {
  const perDay = dayWeights(period, random);
  return periodDates(period).map((date) => {
    const percent = isElevated(profile, date, 12)
      ? profile.workersAi.elevationPercent
      : 100;
    return {
      date,
      zoneId: profile.account.primaryZoneId,
      hour: 12,
      weight: perDay.get(date)! * percent
    };
  });
}

function buildEvents(
  accountId: string,
  serviceName: string,
  idPrefix: string,
  unit: string,
  slots: Slot[],
  quantities: Quantity[]
): UsageEvent[] {
  return slots.map((slot, index) => ({
    eventId: `${idPrefix}-${slot.date}-${slot.zoneId}-${String(slot.hour).padStart(2, "0")}`,
    accountId,
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
function aggregateDaily(accountId: string, events: UsageEvent[]): DailyUsage[] {
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
      accountId,
      serviceName,
      zoneId,
      usageDate: isoDate(usageDate),
      quantity: sumQuantities(ordered.map((e) => e.quantity), "daily usage"),
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
 * One account's data, from its profile alone.
 *
 * Deterministic: the same profile always produces byte-identical output, and
 * because the PRNG is seeded from the profile rather than shared, generating
 * several accounts in any order leaves each one's output unchanged.
 * PRD §13.6, §15.3.
 */
export function generateSyntheticData(
  profile: AccountProfile = GOLDEN_ACCOUNT
): BillingDataset {
  const random = mulberry32(profile.seed);
  const { accountId } = profile.account;

  const priceVersions: PriceVersion[] = [
    { ...profile.workers.price, accountId },
    { ...profile.workersAi.price, accountId }
  ];

  const subscriptions: Subscription[] = [
    {
      subscriptionId: profile.subscriptionId,
      accountId,
      planName: profile.account.planType,
      monthlyFeeCents: profile.platformFeeCents,
      startedOn: isoDate(profile.subscriptionStartedOn),
      endedOn: null
    }
  ];

  // Draw order is [workers, workersAi] within each period, and both draw from
  // the same stream. Reordering these calls changes every downstream quantity.
  const usageEvents: UsageEvent[] = [];
  for (const period of profile.periods) {
    const wSlots = workersSlots(profile, period, random);
    usageEvents.push(
      ...buildEvents(
        accountId,
        profile.workers.price.serviceName,
        profile.workers.eventIdPrefix,
        profile.workers.price.unit,
        wSlots,
        distribute(profile.workers.quantityByPeriod[period], wSlots)
      )
    );

    const aiSlots = workersAiSlots(profile, period, random);
    usageEvents.push(
      ...buildEvents(
        accountId,
        profile.workersAi.price.serviceName,
        profile.workersAi.eventIdPrefix,
        profile.workersAi.price.unit,
        aiSlots,
        distribute(profile.workersAi.quantityByPeriod[period], aiSlots)
      )
    );
  }
  usageEvents.sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId)
  );

  const dailyUsage = aggregateDaily(accountId, usageEvents);

  const fixedLines: FixedLineSource[] = [
    subscriptionFixedLine(subscriptions[0]),
    ...profile.unauthorisedFixedLines.map((line) => ({
      serviceName: line.serviceName,
      amountCents: line.amountCents,
      subscriptionId: null
    }))
  ];

  const ratedCharges: RatedCharge[] = [];
  const invoices: Invoice[] = [];
  const invoiceLines: InvoiceLine[] = [];

  for (const period of profile.periods) {
    const charges = generateRatedCharges(
      accountId,
      period,
      dailyUsage,
      priceVersions
    );
    ratedCharges.push(...charges);

    const { invoice, lines } = generateInvoice(
      accountId,
      period,
      profile.account.currency,
      charges,
      fixedLines
    );
    invoices.push(invoice);
    invoiceLines.push(...lines);
  }

  const accountEvents: AccountEvent[] = profile.accountEvents.map((event) => ({
    ...event,
    accountId
  }));

  return {
    account: { ...profile.account },
    zones: [
      {
        zoneId: profile.account.primaryZoneId,
        accountId,
        zoneName: profile.account.primaryZoneName
      },
      {
        zoneId: profile.secondaryZone.zoneId,
        accountId,
        zoneName: profile.secondaryZone.zoneName
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

import { rateCents } from "./money.js";
import type { PriceVersion, UsageEvent } from "./types.js";

/** One minute, per PRD §12.6. */
export const TIMESTAMP_BUCKET_SECONDS = 60;

export const DUPLICATE_METHOD =
  "exact: repeated event_id; probable: FNV-1a fingerprint over " +
  "account_id|service_name|zone_id|source_event_key|timestamp_bucket(60s)|quantity|unit";

/** FNV-1a. Deterministic, dependency-free, and stable across runtimes. */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function timestampBucket(occurredAt: string): number {
  const seconds = Math.floor(Date.parse(occurredAt) / 1000);
  return Math.floor(seconds / TIMESTAMP_BUCKET_SECONDS);
}

export function fingerprint(event: UsageEvent): string {
  return stableHash(
    [
      event.accountId,
      event.serviceName,
      event.zoneId,
      event.sourceEventKey,
      timestampBucket(event.occurredAt),
      event.quantity,
      event.unit
    ].join("|")
  );
}

export interface DuplicateGroup {
  key: string;
  eventIds: string[];
  /** Quantity attributable to the surplus copies, not the whole group. */
  duplicateQuantity: number;
}

export interface DuplicateReport {
  exactCount: number;
  exactQuantity: number;
  exactCostCents: number;
  probableCount: number;
  probableQuantity: number;
  probableCostCents: number;
  exactGroups: DuplicateGroup[];
  probableGroups: DuplicateGroup[];
  fingerprintsChecked: number;
  sampledRecordIds: string[];
  method: string;
}

function surplusQuantity(events: UsageEvent[]): number {
  // The first occurrence is legitimate; every copy after it is the duplicate.
  return events.slice(1).reduce((total, e) => total + e.quantity, 0);
}

/**
 * PRD §12.6. Duplicates are reported, never removed.
 *
 * `price` is optional: when supplied, the surplus quantity is priced at the
 * overage rate to estimate financial impact.
 */
export function checkDuplicates(
  events: UsageEvent[],
  price?: PriceVersion
): DuplicateReport {
  const byEventId = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const bucket = byEventId.get(event.eventId);
    if (bucket) bucket.push(event);
    else byEventId.set(event.eventId, [event]);
  }

  const exactGroups: DuplicateGroup[] = [];
  for (const [eventId, group] of byEventId) {
    if (group.length > 1) {
      exactGroups.push({
        key: eventId,
        eventIds: group.map((e) => e.eventId),
        duplicateQuantity: surplusQuantity(group)
      });
    }
  }

  // Probable duplicates are distinct event ids sharing a fingerprint, so
  // deduplicate by event id first to avoid double-counting exact duplicates.
  const byFingerprint = new Map<string, Map<string, UsageEvent>>();
  for (const event of events) {
    const key = fingerprint(event);
    let group = byFingerprint.get(key);
    if (!group) {
      group = new Map();
      byFingerprint.set(key, group);
    }
    if (!group.has(event.eventId)) group.set(event.eventId, event);
  }

  const probableGroups: DuplicateGroup[] = [];
  for (const [key, group] of byFingerprint) {
    if (group.size > 1) {
      const members = [...group.values()];
      probableGroups.push({
        key,
        eventIds: members.map((e) => e.eventId),
        duplicateQuantity: surplusQuantity(members)
      });
    }
  }

  const exactQuantity = exactGroups.reduce(
    (total, g) => total + g.duplicateQuantity,
    0
  );
  const probableQuantity = probableGroups.reduce(
    (total, g) => total + g.duplicateQuantity,
    0
  );

  const priceOf = (quantity: number) =>
    price ? rateCents(quantity, price.overageRateCents, price.unitDivisor) : 0;

  return {
    exactCount: exactGroups.length,
    exactQuantity,
    exactCostCents: priceOf(exactQuantity),
    probableCount: probableGroups.length,
    probableQuantity,
    probableCostCents: priceOf(probableQuantity),
    exactGroups,
    probableGroups,
    fingerprintsChecked: byFingerprint.size,
    sampledRecordIds: [...exactGroups, ...probableGroups]
      .flatMap((g) => g.eventIds)
      .slice(0, 10),
    method: DUPLICATE_METHOD
  };
}

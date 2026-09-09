import type { AccountEvent, AccountEventType } from "../domain/types.js";

interface AccountEventRow {
  event_id: string;
  account_id: string;
  event_type: string;
  name: string;
  zone_id: string | null;
  occurred_at: string;
  metadata: string;
}

/**
 * Events in a time window. Type filtering happens in the caller rather than as
 * a dynamic SQL `IN` list: the window is small, and building an IN clause from
 * caller input is exactly the pattern PRD §17 rules out.
 */
export async function listAccountEvents(
  db: D1Database,
  accountId: string,
  fromTimestamp: string,
  toTimestamp: string
): Promise<AccountEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, account_id, event_type, name, zone_id, occurred_at, metadata
         FROM account_events
        WHERE account_id = ?
          AND occurred_at >= ? AND occurred_at <= ?
        ORDER BY occurred_at`
    )
    .bind(accountId, fromTimestamp, toTimestamp)
    .all<AccountEventRow>();

  return results.map((row) => ({
    eventId: row.event_id,
    accountId: row.account_id,
    eventType: row.event_type as AccountEventType,
    name: row.name,
    zoneId: row.zone_id,
    occurredAt: row.occurred_at,
    metadata: row.metadata
  }));
}

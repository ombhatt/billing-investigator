import type { DailyUsage, UsageEvent } from "../domain/types.js";

interface DailyUsageRow {
  account_id: string;
  service_name: string;
  zone_id: string;
  usage_date: string;
  quantity: number;
  unit: string;
  source_event_count: number;
  source_event_first: string;
  source_event_last: string;
}

interface UsageEventRow {
  event_id: string;
  account_id: string;
  service_name: string;
  zone_id: string;
  source_event_key: string;
  occurred_at: string;
  quantity: number;
  unit: string;
}

function toDaily(row: DailyUsageRow): DailyUsage {
  return {
    accountId: row.account_id,
    serviceName: row.service_name,
    zoneId: row.zone_id,
    usageDate: row.usage_date,
    quantity: row.quantity,
    unit: row.unit,
    sourceEventCount: row.source_event_count,
    sourceEventFirst: row.source_event_first,
    sourceEventLast: row.source_event_last
  };
}

function toEvent(row: UsageEventRow): UsageEvent {
  return {
    eventId: row.event_id,
    accountId: row.account_id,
    serviceName: row.service_name,
    zoneId: row.zone_id,
    sourceEventKey: row.source_event_key,
    occurredAt: row.occurred_at,
    quantity: row.quantity,
    unit: row.unit
  };
}

const DAILY_COLUMNS = `account_id, service_name, zone_id, usage_date, quantity,
                       unit, source_event_count, source_event_first, source_event_last`;

/**
 * Optional zone filtering uses two fixed statements rather than a query built
 * by string concatenation, so there is no path by which caller input reaches
 * the SQL text. PRD §17.
 */
export async function listDailyUsage(
  db: D1Database,
  accountId: string,
  serviceName: string,
  from: string,
  to: string,
  zoneId?: string
): Promise<DailyUsage[]> {
  const statement =
    zoneId === undefined
      ? db
          .prepare(
            `SELECT ${DAILY_COLUMNS}
               FROM daily_usage
              WHERE account_id = ? AND service_name = ?
                AND usage_date >= ? AND usage_date <= ?
              ORDER BY usage_date, zone_id`
          )
          .bind(accountId, serviceName, from, to)
      : db
          .prepare(
            `SELECT ${DAILY_COLUMNS}
               FROM daily_usage
              WHERE account_id = ? AND service_name = ?
                AND usage_date >= ? AND usage_date <= ?
                AND zone_id = ?
              ORDER BY usage_date, zone_id`
          )
          .bind(accountId, serviceName, from, to, zoneId);

  const { results } = await statement.all<DailyUsageRow>();
  return results.map(toDaily);
}

/** Every service's daily rows for one period, used by reconciliation. */
export async function listDailyUsageForPeriod(
  db: D1Database,
  accountId: string,
  period: string
): Promise<DailyUsage[]> {
  const { results } = await db
    .prepare(
      `SELECT ${DAILY_COLUMNS}
         FROM daily_usage
        WHERE account_id = ? AND usage_date LIKE ?
        ORDER BY usage_date, service_name, zone_id`
    )
    .bind(accountId, `${period}-%`)
    .all<DailyUsageRow>();
  return results.map(toDaily);
}

export async function listUsageEvents(
  db: D1Database,
  accountId: string,
  serviceName: string,
  fromTimestamp: string,
  toTimestamp: string
): Promise<UsageEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, account_id, service_name, zone_id, source_event_key,
              occurred_at, quantity, unit
         FROM usage_events
        WHERE account_id = ? AND service_name = ?
          AND occurred_at >= ? AND occurred_at <= ?
        ORDER BY occurred_at, event_id`
    )
    .bind(accountId, serviceName, fromTimestamp, toTimestamp)
    .all<UsageEventRow>();
  return results.map(toEvent);
}

/** All services' events for one period, used by reconciliation. */
export async function listUsageEventsForPeriod(
  db: D1Database,
  accountId: string,
  period: string
): Promise<UsageEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT event_id, account_id, service_name, zone_id, source_event_key,
              occurred_at, quantity, unit
         FROM usage_events
        WHERE account_id = ? AND occurred_at LIKE ?
        ORDER BY occurred_at, event_id`
    )
    .bind(accountId, `${period}-%`)
    .all<UsageEventRow>();
  return results.map(toEvent);
}

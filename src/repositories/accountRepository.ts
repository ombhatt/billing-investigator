import type { Account, Zone } from "../domain/types.js";

interface AccountRow {
  account_id: string;
  display_name: string;
  plan_type: string;
  currency: string;
  tax_status: string;
  primary_zone_id: string;
  primary_zone_name: string;
  is_synthetic: number;
}

interface ZoneRow {
  zone_id: string;
  account_id: string;
  zone_name: string;
}

function toAccount(row: AccountRow): Account & { isSynthetic: boolean } {
  return {
    accountId: row.account_id,
    displayName: row.display_name,
    planType: row.plan_type,
    currency: row.currency,
    taxStatus: row.tax_status,
    primaryZoneId: row.primary_zone_id,
    primaryZoneName: row.primary_zone_name,
    isSynthetic: row.is_synthetic === 1
  };
}

/**
 * Read-only lookup by primary key. Parameterized — no caller-supplied value is
 * ever interpolated into SQL anywhere in this layer. PRD §17.
 */
export async function findAccountById(
  db: D1Database,
  accountId: string
): Promise<(Account & { isSynthetic: boolean }) | null> {
  const row = await db
    .prepare(
      `SELECT account_id, display_name, plan_type, currency, tax_status,
              primary_zone_id, primary_zone_name, is_synthetic
         FROM accounts
        WHERE account_id = ?`
    )
    .bind(accountId)
    .first<AccountRow>();
  return row ? toAccount(row) : null;
}

export async function listZones(
  db: D1Database,
  accountId: string
): Promise<Zone[]> {
  const { results } = await db
    .prepare(
      `SELECT zone_id, account_id, zone_name
         FROM zones
        WHERE account_id = ?
        ORDER BY zone_id`
    )
    .bind(accountId)
    .all<ZoneRow>();
  return results.map((row) => ({
    zoneId: row.zone_id,
    accountId: row.account_id,
    zoneName: row.zone_name
  }));
}

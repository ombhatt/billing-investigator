export interface AccountRow {
  account_id: string;
  display_name: string;
  plan_type: string;
  currency: string;
  tax_status: string;
  primary_zone_id: string;
  primary_zone_name: string;
  is_synthetic: number;
}

/**
 * Read-only lookup by primary key. Parameterized — the account id is never
 * interpolated into SQL. PRD §17.
 */
export async function findAccountById(
  db: D1Database,
  accountId: string
): Promise<AccountRow | null> {
  return await db
    .prepare(
      `SELECT account_id, display_name, plan_type, currency, tax_status,
              primary_zone_id, primary_zone_name, is_synthetic
         FROM accounts
        WHERE account_id = ?`
    )
    .bind(accountId)
    .first<AccountRow>();
}

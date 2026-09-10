import type { Subscription } from "../domain/types.js";

interface SubscriptionRow {
  subscription_id: string;
  account_id: string;
  plan_name: string;
  monthly_fee_cents: number;
  started_on: string;
  ended_on: string | null;
}

/**
 * Subscriptions authorise the fixed fees an invoice charges. Nothing read this
 * table until review showed an unauthorised platform-fee increase being
 * reported as fully explained and correct.
 */
export async function listSubscriptions(
  db: D1Database,
  accountId: string
): Promise<Subscription[]> {
  const { results } = await db
    .prepare(
      `SELECT subscription_id, account_id, plan_name, monthly_fee_cents,
              started_on, ended_on
         FROM subscriptions
        WHERE account_id = ?
        ORDER BY started_on`
    )
    .bind(accountId)
    .all<SubscriptionRow>();

  return results.map((row) => ({
    subscriptionId: row.subscription_id,
    accountId: row.account_id,
    planName: row.plan_name,
    monthlyFeeCents: row.monthly_fee_cents,
    startedOn: row.started_on,
    endedOn: row.ended_on
  }));
}

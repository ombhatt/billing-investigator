import type { PriceVersion, RatedCharge } from "../domain/types.js";

interface PriceVersionRow {
  price_version_id: string;
  account_id: string;
  service_name: string;
  service_family: string;
  included_quantity: number;
  overage_rate_cents: number;
  unit_divisor: number;
  unit: string;
  fixed_fee_cents: number;
  effective_from: string;
  effective_to: string | null;
}

interface RatedChargeRow {
  rated_charge_id: string;
  account_id: string;
  service_name: string;
  period: string;
  consumed_quantity: number;
  included_quantity: number;
  billable_quantity: number;
  price_version_id: string;
  amount_cents: number;
}

const PRICE_COLUMNS = `price_version_id, account_id, service_name, service_family,
                       included_quantity, overage_rate_cents, unit_divisor, unit,
                       fixed_fee_cents, effective_from, effective_to`;

function toPrice(row: PriceVersionRow): PriceVersion {
  return {
    priceVersionId: row.price_version_id,
    accountId: row.account_id,
    serviceName: row.service_name,
    serviceFamily: row.service_family,
    includedQuantity: row.included_quantity,
    overageRateCents: row.overage_rate_cents,
    unitDivisor: row.unit_divisor,
    unit: row.unit,
    fixedFeeCents: row.fixed_fee_cents,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to
  };
}

export async function listPriceVersions(
  db: D1Database,
  accountId: string
): Promise<PriceVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PRICE_COLUMNS}
         FROM price_versions
        WHERE account_id = ?
        ORDER BY service_name, effective_from`
    )
    .bind(accountId)
    .all<PriceVersionRow>();
  return results.map(toPrice);
}

/**
 * Versions for one service overlapping a window. An open-ended version
 * (effective_to NULL) overlaps anything starting on or after its start.
 */
export async function listPriceVersionsOverlapping(
  db: D1Database,
  accountId: string,
  serviceName: string,
  from: string,
  to: string
): Promise<PriceVersion[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PRICE_COLUMNS}
         FROM price_versions
        WHERE account_id = ? AND service_name = ?
          AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from`
    )
    .bind(accountId, serviceName, to, from)
    .all<PriceVersionRow>();
  return results.map(toPrice);
}

export async function listRatedCharges(
  db: D1Database,
  accountId: string,
  period: string
): Promise<RatedCharge[]> {
  const { results } = await db
    .prepare(
      `SELECT rated_charge_id, account_id, service_name, period,
              consumed_quantity, included_quantity, billable_quantity,
              price_version_id, amount_cents
         FROM rated_charges
        WHERE account_id = ? AND period = ?
        ORDER BY service_name`
    )
    .bind(accountId, period)
    .all<RatedChargeRow>();

  return results.map((row) => ({
    ratedChargeId: row.rated_charge_id,
    accountId: row.account_id,
    serviceName: row.service_name,
    period: row.period,
    consumedQuantity: row.consumed_quantity,
    includedQuantity: row.included_quantity,
    billableQuantity: row.billable_quantity,
    priceVersionId: row.price_version_id,
    amountCents: row.amount_cents
  }));
}

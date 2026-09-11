import { billingPeriod, cents, isoDate, quantity } from "../domain/units.js";
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
    includedQuantity: quantity(
      row.included_quantity,
      `price ${row.price_version_id} included quantity`
    ),
    overageRateCents: cents(
      row.overage_rate_cents,
      `price ${row.price_version_id} overage rate`
    ),
    unitDivisor: row.unit_divisor,
    unit: row.unit,
    fixedFeeCents: cents(
      row.fixed_fee_cents,
      `price ${row.price_version_id} fixed fee`
    ),
    effectiveFrom: isoDate(
      row.effective_from,
      `price ${row.price_version_id} effective from`
    ),
    effectiveTo:
      row.effective_to === null
        ? null
        : isoDate(row.effective_to, `price ${row.price_version_id} effective to`)
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
    period: billingPeriod(row.period, "rated charge period"),
    consumedQuantity: quantity(row.consumed_quantity, "consumed quantity"),
    includedQuantity: quantity(
      row.included_quantity,
      `price ${row.price_version_id} included quantity`
    ),
    billableQuantity: quantity(row.billable_quantity, "billable quantity"),
    priceVersionId: row.price_version_id,
    amountCents: cents(row.amount_cents, `charge ${row.rated_charge_id} amount`)
  }));
}

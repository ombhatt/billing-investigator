import type { BillingDataset } from "../../src/domain/types.js";

/**
 * Loads a generated dataset into the test database with bound statements,
 * chunked so no single batch grows unreasonably large.
 */
async function insertAll(
  db: D1Database,
  sql: string,
  rows: (string | number | null)[][]
): Promise<void> {
  if (rows.length === 0) return;
  const prepared = db.prepare(sql);
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(rows.slice(i, i + CHUNK).map((row) => prepared.bind(...row)));
  }
}

export async function seedDataset(
  db: D1Database,
  dataset: BillingDataset
): Promise<void> {
  // Reverse dependency order so foreign keys stay satisfied.
  for (const table of [
    "invoice_lines",
    "invoices",
    "rated_charges",
    "daily_usage",
    "usage_events",
    "account_events",
    "price_versions",
    "subscriptions",
    "zones",
    "accounts"
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }

  const a = dataset.account;
  await db
    .prepare(
      `INSERT INTO accounts (account_id, display_name, plan_type, currency,
        tax_status, primary_zone_id, primary_zone_name, is_synthetic)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .bind(
      a.accountId,
      a.displayName,
      a.planType,
      a.currency,
      a.taxStatus,
      a.primaryZoneId,
      a.primaryZoneName
    )
    .run();

  await insertAll(
    db,
    "INSERT INTO zones (zone_id, account_id, zone_name) VALUES (?, ?, ?)",
    dataset.zones.map((z) => [z.zoneId, z.accountId, z.zoneName])
  );

  await insertAll(
    db,
    `INSERT INTO subscriptions (subscription_id, account_id, plan_name,
      monthly_fee_cents, started_on, ended_on) VALUES (?, ?, ?, ?, ?, ?)`,
    dataset.subscriptions.map((s) => [
      s.subscriptionId,
      s.accountId,
      s.planName,
      s.monthlyFeeCents,
      s.startedOn,
      s.endedOn
    ])
  );

  await insertAll(
    db,
    `INSERT INTO price_versions (price_version_id, account_id, service_name,
      service_family, included_quantity, overage_rate_cents, unit_divisor, unit,
      fixed_fee_cents, effective_from, effective_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    dataset.priceVersions.map((p) => [
      p.priceVersionId,
      p.accountId,
      p.serviceName,
      p.serviceFamily,
      p.includedQuantity,
      p.overageRateCents,
      p.unitDivisor,
      p.unit,
      p.fixedFeeCents,
      p.effectiveFrom,
      p.effectiveTo
    ])
  );

  await insertAll(
    db,
    `INSERT INTO usage_events (event_id, account_id, service_name, zone_id,
      source_event_key, occurred_at, quantity, unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    dataset.usageEvents.map((e) => [
      e.eventId,
      e.accountId,
      e.serviceName,
      e.zoneId,
      e.sourceEventKey,
      e.occurredAt,
      e.quantity,
      e.unit
    ])
  );

  await insertAll(
    db,
    `INSERT INTO daily_usage (account_id, service_name, zone_id, usage_date,
      quantity, unit, source_event_count, source_event_first, source_event_last)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    dataset.dailyUsage.map((d) => [
      d.accountId,
      d.serviceName,
      d.zoneId,
      d.usageDate,
      d.quantity,
      d.unit,
      d.sourceEventCount,
      d.sourceEventFirst,
      d.sourceEventLast
    ])
  );

  await insertAll(
    db,
    `INSERT INTO rated_charges (rated_charge_id, account_id, service_name, period,
      consumed_quantity, included_quantity, billable_quantity, price_version_id,
      amount_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    dataset.ratedCharges.map((r) => [
      r.ratedChargeId,
      r.accountId,
      r.serviceName,
      r.period,
      r.consumedQuantity,
      r.includedQuantity,
      r.billableQuantity,
      r.priceVersionId,
      r.amountCents
    ])
  );

  await insertAll(
    db,
    `INSERT INTO invoices (invoice_id, account_id, period, status, currency,
      subtotal_cents, credit_cents, tax_cents, total_cents, issued_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    dataset.invoices.map((i) => [
      i.invoiceId,
      i.accountId,
      i.period,
      i.status,
      i.currency,
      i.subtotalCents,
      i.creditCents,
      i.taxCents,
      i.totalCents,
      i.issuedOn
    ])
  );

  await insertAll(
    db,
    `INSERT INTO invoice_lines (line_id, invoice_id, account_id, service_name,
      line_type, quantity, amount_cents, rated_charge_id, subscription_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    dataset.invoiceLines.map((l) => [
      l.lineId,
      l.invoiceId,
      l.accountId,
      l.serviceName,
      l.lineType,
      l.quantity,
      l.amountCents,
      l.ratedChargeId,
      l.subscriptionId
    ])
  );

  await insertAll(
    db,
    `INSERT INTO account_events (event_id, account_id, event_type, name, zone_id,
      occurred_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    dataset.accountEvents.map((e) => [
      e.eventId,
      e.accountId,
      e.eventType,
      e.name,
      e.zoneId,
      e.occurredAt,
      e.metadata
    ])
  );
}

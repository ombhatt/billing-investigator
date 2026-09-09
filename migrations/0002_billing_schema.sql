-- Remaining P0 billing schema. PRD §14.
--
-- Investigation state (plan, evidence, tool executions) is not here: it lives
-- in the agent's Durable Object SQLite, which owns it. PRD §14 lists those
-- tables only as a suggestion "if state is not entirely agent-local".
--
-- Currency is INTEGER cents throughout. Quantities are INTEGER units.

CREATE TABLE IF NOT EXISTS zones (
  zone_id    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(account_id),
  zone_name  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_account ON zones(account_id);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id   TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(account_id),
  plan_name         TEXT NOT NULL,
  monthly_fee_cents INTEGER NOT NULL,
  started_on        TEXT NOT NULL,
  ended_on          TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_account ON subscriptions(account_id);

-- Effective-dated contract pricing: fixed fee plus one linear overage tier.
-- More tiers can be added later without the P0 engine computing them.
CREATE TABLE IF NOT EXISTS price_versions (
  price_version_id   TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(account_id),
  service_name       TEXT NOT NULL,
  service_family     TEXT NOT NULL,
  included_quantity  INTEGER NOT NULL DEFAULT 0,
  overage_rate_cents INTEGER NOT NULL DEFAULT 0,
  unit_divisor       INTEGER NOT NULL DEFAULT 1,
  unit               TEXT NOT NULL,
  fixed_fee_cents    INTEGER NOT NULL DEFAULT 0,
  effective_from     TEXT NOT NULL,
  effective_to       TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_versions_lookup
  ON price_versions(account_id, service_name, effective_from);

CREATE TABLE IF NOT EXISTS usage_events (
  event_id         TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(account_id),
  service_name     TEXT NOT NULL,
  zone_id          TEXT NOT NULL REFERENCES zones(zone_id),
  source_event_key TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  quantity         INTEGER NOT NULL,
  unit             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_service_time
  ON usage_events(account_id, service_name, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_zone
  ON usage_events(account_id, zone_id, occurred_at);

-- Lineage: source_event_* columns tie each row back to the events it sums.
CREATE TABLE IF NOT EXISTS daily_usage (
  account_id         TEXT NOT NULL REFERENCES accounts(account_id),
  service_name       TEXT NOT NULL,
  zone_id            TEXT NOT NULL REFERENCES zones(zone_id),
  usage_date         TEXT NOT NULL,
  quantity           INTEGER NOT NULL,
  unit               TEXT NOT NULL,
  source_event_count INTEGER NOT NULL,
  source_event_first TEXT NOT NULL,
  source_event_last  TEXT NOT NULL,
  PRIMARY KEY (account_id, service_name, zone_id, usage_date)
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_service_date
  ON daily_usage(account_id, service_name, usage_date);

-- Lineage: references the price version used and the period aggregated.
CREATE TABLE IF NOT EXISTS rated_charges (
  rated_charge_id   TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts(account_id),
  service_name      TEXT NOT NULL,
  period            TEXT NOT NULL,
  consumed_quantity INTEGER NOT NULL,
  included_quantity INTEGER NOT NULL,
  billable_quantity INTEGER NOT NULL,
  price_version_id  TEXT NOT NULL REFERENCES price_versions(price_version_id),
  amount_cents      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rated_charges_period
  ON rated_charges(account_id, period);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id     TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(account_id),
  period         TEXT NOT NULL,
  status         TEXT NOT NULL,
  currency       TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  credit_cents   INTEGER NOT NULL DEFAULT 0,
  tax_cents      INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL,
  issued_on      TEXT NOT NULL,
  UNIQUE (account_id, period)
);
CREATE INDEX IF NOT EXISTS idx_invoices_account_period
  ON invoices(account_id, period);

-- Lineage: each line points at its rated charge or its subscription.
CREATE TABLE IF NOT EXISTS invoice_lines (
  line_id         TEXT PRIMARY KEY,
  invoice_id      TEXT NOT NULL REFERENCES invoices(invoice_id),
  account_id      TEXT NOT NULL REFERENCES accounts(account_id),
  service_name    TEXT NOT NULL,
  line_type       TEXT NOT NULL CHECK (line_type IN ('fixed', 'usage')),
  quantity        INTEGER,
  amount_cents    INTEGER NOT NULL,
  rated_charge_id TEXT REFERENCES rated_charges(rated_charge_id),
  subscription_id TEXT REFERENCES subscriptions(subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS account_events (
  event_id    TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(account_id),
  event_type  TEXT NOT NULL,
  name        TEXT NOT NULL,
  zone_id     TEXT REFERENCES zones(zone_id),
  occurred_at TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_account_events_time
  ON account_events(account_id, occurred_at);

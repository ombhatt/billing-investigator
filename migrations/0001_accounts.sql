-- Milestone 1: accounts table only.
-- Invoices, usage, pricing, events, and investigation tables arrive in later
-- milestones per docs/BUILD_PLAN.md.

CREATE TABLE IF NOT EXISTS accounts (
  account_id        TEXT PRIMARY KEY,
  display_name      TEXT NOT NULL,
  plan_type         TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  tax_status        TEXT NOT NULL,
  primary_zone_id   TEXT NOT NULL,
  primary_zone_name TEXT NOT NULL,
  -- All demo data is fictional. PRD §13.1 / FR-14.
  is_synthetic      INTEGER NOT NULL DEFAULT 1
);

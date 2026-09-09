-- Golden account, PRD §13.2. Fictional data.
-- Idempotent so re-seeding a local database is safe.

INSERT OR REPLACE INTO accounts (
  account_id,
  display_name,
  plan_type,
  currency,
  tax_status,
  primary_zone_id,
  primary_zone_name,
  is_synthetic
) VALUES (
  'abc123',
  'Acme Corp.',
  'Synthetic Enterprise',
  'USD',
  'exempt',
  'zone-api-acme',
  'api.acme.example',
  1
);

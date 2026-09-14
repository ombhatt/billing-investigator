import type { InvestigationFacts } from "../../src/agent/facts.js";

/**
 * The duplicated-usage account's fact block, transcribed once.
 *
 * The counterpart to `GOLDEN_FACTS`, and the reason it exists: every value in
 * that block agrees with every other, so it can only ever demonstrate the
 * system saying yes. This one is the case where **reconciliation passes, the
 * variance is fully explained, and the invoice is still not correct** — which is
 * what shows why PRD rule 7 has three clauses rather than one.
 *
 * Read the three lines in the middle together:
 *   reconciliation_status  passed
 *   explained_percent      100
 *   probable_duplicate_count 120   <- and so the verdict is still `false`
 *
 * Mirrors the block in `CLAUDE.md`. `docs/BUILD_PLAN_P1.md` Milestone 9.
 */
export const DUPLICATE_FACTS: InvestigationFacts = {
  current_total_cents: 1225960,
  comparison_total_cents: 1118000,
  variance_cents: 107960,
  percentage_variance_display: 9.7,
  workers_variance_cents: 107460,
  workers_ai_variance_cents: 500,
  price_changed: false,
  // Accepted but immaterial: the level steps *down* when the replayed window
  // ends, which is a real change and not a driver of the bill.
  change_date: "2026-08-08",
  change_point_material: false,
  change_point_confidence: "low",
  correlated_event_id: null,
  exact_duplicate_count: 0,
  probable_duplicate_count: 120,
  reconciliation_status: "passed",
  explained_percent: 100,
  volume_effect_cents: 107960,
  price_effect_cents: 0,
  confidence: "low"
};

import type { InvestigationFacts } from "../../src/agent/facts.js";

/**
 * The PRD §20.4 fact block, transcribed once.
 *
 * Three implementations compute this independently — pure domain
 * (`golden.spec.ts`), the nine tools against D1 (`goldenToolRun.spec.ts`), and
 * the agent loop (`agentGolden.spec.ts`) — and each asserts against this same
 * transcription. That is the independence that matters: the expected values are
 * published figures being checked against, not a fourth computation that could
 * drift in step with the others. Repeating the literal three times only created
 * three places to update when the PRD moves.
 *
 * Mirrors the block in `CLAUDE.md`; `docs/BUILD_STATUS.md` tabulates the same
 * values per layer.
 */
export const GOLDEN_FACTS: InvestigationFacts = {
  current_total_cents: 2_172_000,
  comparison_total_cents: 1_690_000,
  variance_cents: 482_000,
  percentage_variance_display: 28.5,
  workers_variance_cents: 464_000,
  workers_ai_variance_cents: 18_000,
  price_changed: false,
  change_date: "2026-08-14",
  // The change point was accepted, and these record on what basis. A rejected
  // candidate leaves all three null rather than the date alone.
  change_point_material: true,
  change_point_confidence: "high",
  correlated_event_id: "dep-1842",
  exact_duplicate_count: 0,
  probable_duplicate_count: 0,
  reconciliation_status: "passed",
  explained_percent: 100,
  volume_effect_cents: 482_000,
  price_effect_cents: 0,
  confidence: "high"
};

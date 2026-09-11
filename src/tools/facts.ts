import type { Confidence } from "../domain/confidence.js";
import type { ToolName, ToolOutput } from "./catalog.js";

/**
 * The structured block every path must agree on: pure domain, the M3 runner,
 * and the agent. Kept in one place so those paths cannot drift.
 *
 * snake_case here is deliberate, and is the one exception to camelCase in this
 * codebase. This type *is* the external serialization boundary rather than
 * something behind one: `npm run golden` prints it with `JSON.stringify`, and
 * these key names are the published contract — PRD §24, the golden fact block
 * in CLAUDE.md, and `docs/BUILD_STATUS.md`, asserted verbatim by the golden
 * tests. Everything that feeds it (`ToolOutput`, the domain types) is camelCase
 * and converts in the reducers below, which is the translation step.
 */
export interface InvestigationFacts {
  current_total_cents: number | null;
  comparison_total_cents: number | null;
  variance_cents: number | null;
  percentage_variance_display: number | null;
  workers_variance_cents: number | null;
  workers_ai_variance_cents: number | null;
  price_changed: boolean | null;
  change_date: string | null;
  /** Qualifiers for `change_date`, kept so a weak signal cannot read as a strong one. */
  change_point_material: boolean | null;
  change_point_confidence: "high" | "medium" | "low" | null;
  correlated_event_id: string | null;
  exact_duplicate_count: number | null;
  probable_duplicate_count: number | null;
  reconciliation_status: "passed" | "failed" | null;
  explained_percent: number | null;
  /** Deterministic signal for "consumption moved", used to derive required checks. */
  volume_effect_cents: number | null;
  price_effect_cents: number | null;
  confidence: Confidence | null;
}

export function emptyFacts(): InvestigationFacts {
  return {
    current_total_cents: null,
    comparison_total_cents: null,
    variance_cents: null,
    percentage_variance_display: null,
    workers_variance_cents: null,
    workers_ai_variance_cents: null,
    price_changed: null,
    change_date: null,
    change_point_material: null,
    change_point_confidence: null,
    correlated_event_id: null,
    exact_duplicate_count: null,
    probable_duplicate_count: null,
    reconciliation_status: null,
    explained_percent: null,
    volume_effect_cents: null,
    price_effect_cents: null,
    confidence: null
  };
}

/** Extra context a reducer may need that is not in the tool's own output. */
export interface FactContext {
  changeDate?: string | null;
}

/**
 * One reducer per tool, each typed to that tool's actual output, so `data` is
 * `ToolOutput<N>` and a renamed or removed field fails the build here rather
 * than silently reading `undefined`. ARCHITECTURE.md §22.
 *
 * Tools absent from this map contribute no facts, which is a statement rather
 * than an omission: `get_account_context` and `get_usage_timeseries` produce
 * evidence for the reader, not values the verdict is computed from.
 */
type FactReducer<N extends ToolName> = (
  facts: InvestigationFacts,
  data: ToolOutput<N>,
  context: FactContext
) => InvestigationFacts;

type FactReducers = { [N in ToolName]?: FactReducer<N> };

const REDUCERS: FactReducers = {
  compare_invoices: (facts, d) => {
    const variance = (name: string) =>
      d.services.find((s) => s.serviceName === name)?.varianceCents ?? 0;
    return {
      ...facts,
      current_total_cents: d.currentTotalCents,
      comparison_total_cents: d.comparisonTotalCents,
      variance_cents: d.varianceCents,
      percentage_variance_display: d.percentageVarianceDisplay,
      workers_variance_cents: variance("Workers"),
      workers_ai_variance_cents: variance("Workers AI")
    };
  },

  decompose_variance: (facts, d) => ({
    ...facts,
    explained_percent: d.explainedPercent,
    volume_effect_cents: d.volumeEffectCents,
    price_effect_cents: d.priceEffectCents
  }),

  // Checked once per metered service, so this accumulates rather than
  // overwrites: a price change anywhere on the invoice is a price change.
  get_price_versions: (facts, d) => ({
    ...facts,
    price_changed: facts.price_changed === true ? true : d.priceChanged
  }),

  // Only an accepted change point becomes a fact, and its qualifiers travel
  // with the date — without them a rejected candidate reads downstream exactly
  // like a confirmed shift. ARCHITECTURE.md §18.
  detect_usage_change_point: (facts, d) =>
    d.detected
      ? {
          ...facts,
          change_date: d.changeDate,
          change_point_material: d.material,
          change_point_confidence: d.confidence
        }
      : facts,

  get_account_events: (facts, d, context) => {
    const anchor = context.changeDate
      ? Date.parse(`${context.changeDate}T00:00:00Z`)
      : null;
    if (anchor === null || d.events.length === 0) return facts;
    // Nearest in time wins. Proximity only — never a causal claim. PRD §12.8.
    const nearest = [...d.events].sort(
      (a, b) =>
        Math.abs(Date.parse(a.occurredAt) - anchor) -
        Math.abs(Date.parse(b.occurredAt) - anchor)
    )[0];
    return { ...facts, correlated_event_id: nearest.eventId };
  },

  // Also per service, and also summed: duplicates found on any metered service
  // are duplicates on the invoice.
  check_duplicate_usage: (facts, d) => ({
    ...facts,
    exact_duplicate_count: (facts.exact_duplicate_count ?? 0) + d.exactCount,
    probable_duplicate_count:
      (facts.probable_duplicate_count ?? 0) + d.probableCount
  }),

  reconcile_invoice: (facts, d) => ({
    ...facts,
    reconciliation_status: d.status
  })
};

/**
 * Folds one tool result into the fact block. Facts only ever come from tool
 * output, never from anything the model said. PRD §10.5 rule 9.
 */
export function applyToolFacts<N extends ToolName>(
  facts: InvestigationFacts,
  tool: N,
  data: ToolOutput<N>,
  context: FactContext = {}
): InvestigationFacts {
  const reduce = REDUCERS[tool] as FactReducer<N> | undefined;
  return reduce ? reduce(facts, data, context) : facts;
}

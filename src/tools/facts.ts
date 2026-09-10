import type { Confidence } from "../domain/confidence.js";

/**
 * The structured block every path must agree on: pure domain, the M3 runner,
 * and the agent. Kept in one place so those paths cannot drift.
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
  correlated_event_id: string | null;
  exact_duplicate_count: number | null;
  probable_duplicate_count: number | null;
  reconciliation_status: "passed" | "failed" | null;
  explained_percent: number | null;
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
    correlated_event_id: null,
    exact_duplicate_count: null,
    probable_duplicate_count: null,
    reconciliation_status: null,
    explained_percent: null,
    confidence: null
  };
}

interface CompareData {
  currentTotalCents: number;
  comparisonTotalCents: number;
  varianceCents: number;
  percentageVarianceDisplay: number | null;
  services: { serviceName: string; varianceCents: number }[];
}

/**
 * Folds one tool result into the fact block. Facts only ever come from tool
 * output, never from anything the model said. PRD §10.5 rule 9.
 */
export function applyToolFacts(
  facts: InvestigationFacts,
  tool: string,
  data: unknown,
  options: { changeDate?: string | null } = {}
): InvestigationFacts {
  switch (tool) {
    case "compare_invoices": {
      const d = data as CompareData;
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
    }

    case "decompose_variance": {
      const d = data as { explainedPercent: number };
      return { ...facts, explained_percent: d.explainedPercent };
    }

    case "get_price_versions": {
      const d = data as { priceChanged: boolean };
      return { ...facts, price_changed: d.priceChanged };
    }

    case "detect_usage_change_point": {
      const d = data as { changeDate: string | null };
      return { ...facts, change_date: d.changeDate };
    }

    case "get_account_events": {
      const d = data as { events: { eventId: string; occurredAt: string }[] };
      const anchor = options.changeDate
        ? Date.parse(`${options.changeDate}T00:00:00Z`)
        : null;
      if (anchor === null || d.events.length === 0) return facts;
      // Nearest in time wins. Proximity only — never a causal claim. PRD §12.8.
      const nearest = [...d.events].sort(
        (a, b) =>
          Math.abs(Date.parse(a.occurredAt) - anchor) -
          Math.abs(Date.parse(b.occurredAt) - anchor)
      )[0];
      return { ...facts, correlated_event_id: nearest.eventId };
    }

    case "check_duplicate_usage": {
      const d = data as { exactCount: number; probableCount: number };
      return {
        ...facts,
        exact_duplicate_count: d.exactCount,
        probable_duplicate_count: d.probableCount
      };
    }

    case "reconcile_invoice": {
      const d = data as { status: "passed" | "failed" };
      return { ...facts, reconciliation_status: d.status };
    }

    default:
      return facts;
  }
}

import { describe, expect, it } from "vitest";
import { goldenFacts, analyseInvoiceVariance } from "../../src/domain/invoiceVarianceCase.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import {
  COMPARISON_PERIOD,
  CURRENT_PERIOD,
  SERVICE_WORKERS
} from "../../seed/constants.js";

const input = {
  dataset: generateSyntheticData(),
  currentPeriod: CURRENT_PERIOD,
  comparisonPeriod: COMPARISON_PERIOD,
  focusService: SERVICE_WORKERS
};

/**
 * PRD §20.4. These are the structured facts the final answer is produced from.
 * Prose is never asserted — only the numbers behind it.
 */
describe("golden fact block", () => {
  it("matches the PRD exactly", () => {
    expect(goldenFacts(input)).toEqual({
      current_total_cents: 2_172_000,
      comparison_total_cents: 1_690_000,
      variance_cents: 482_000,
      percentage_variance_display: 28.5,
      workers_variance_cents: 464_000,
      workers_ai_variance_cents: 18_000,
      price_changed: false,
      change_date: "2026-08-14",
      correlated_event_id: "dep-1842",
      exact_duplicate_count: 0,
      probable_duplicate_count: 0,
      reconciliation_status: "passed",
      explained_percent: 100,
      volume_effect_cents: 482_000,
      price_effect_cents: 0,
      confidence: "high"
    });
  });

  it("is computed without any LLM, database or network call", async () => {
    // The whole analysis path must import nothing that needs a runtime binding.
    const analysis = analyseInvoiceVariance(input);
    expect(analysis.reconciliation.status).toBe("passed");
    expect(analysis.confidence.confidence).toBe("high");
  });

  it("explains the full variance with evidence for each material claim", () => {
    const analysis = analyseInvoiceVariance(input);

    // 100% explained, nothing left over.
    expect(analysis.decomposition.unexplainedCents).toBe(0);
    // Price ruled out by an actual version lookup, not an assumption.
    expect(analysis.priceVersions).toHaveLength(1);
    expect(analysis.priceVersions[0].priceVersionId).toBe("price-workers-2026-01");
    // Correlation, never causation.
    expect(analysis.correlatedEvents[0].event.eventType).toBe("deployment");
    expect(analysis.changePoint.method).toMatch(/median/);
  });

  it("keeps the confidence rating deterministic", () => {
    expect(analyseInvoiceVariance(input).confidence.reasons).toContain(
      "reconciliation passed at every boundary"
    );
  });
});

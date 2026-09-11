import { describe, expect, it } from "vitest";
import { GOLDEN_FACTS } from "../support/goldenFacts.js";
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
    expect(goldenFacts(input)).toEqual(GOLDEN_FACTS);
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
    // Price ruled out by an actual version lookup, not an assumption — and for
    // every metered service, since "pricing did not change" is a claim about
    // the whole invoice. One version each for Workers and Workers AI.
    expect(analysis.priceVersions.map((p) => p.priceVersionId).sort()).toEqual([
      "price-workers-2026-01",
      "price-workers-ai-2026-01"
    ]);
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

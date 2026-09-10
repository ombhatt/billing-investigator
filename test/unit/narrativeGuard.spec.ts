import { describe, expect, it } from "vitest";
import {
  checkNarrative,
  safeNarrative,
  type NarrativeContext
} from "../../src/agent/narrativeGuard.js";
import { emptyFacts } from "../../src/tools/facts.js";
import type { EvidenceCard } from "../../src/types/tools.js";

/**
 * Review showed all four fabrication kinds reaching the user unchanged:
 *
 *   "The invoice rose by $99,999 because dep-FAKE caused duplicate charges.
 *    The invoice is correct."
 *
 * Structured facts stayed correct throughout — which is the point. It is the
 * sentence, not the fact table, that gets pasted into a customer email.
 */

const facts = {
  ...emptyFacts(),
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
  reconciliation_status: "passed" as const,
  explained_percent: 100,
  confidence: "high" as const
};

const evidence: EvidenceCard[] = [
  {
    label: "Invoice total change",
    value: "$16,900.00 to $21,720.00 ($4,820.00, 28.5%)",
    source: "compare_invoices",
    recordIds: ["invoices:inv-abc123-2026-08"],
    period: "2026-07 to 2026-08",
    status: "confirmed"
  },
  {
    label: "deployment: edge-router-v3",
    value: "dep-1842 at 2026-08-14T09:58:00Z on zone-api-acme",
    source: "get_account_events",
    recordIds: ["account_events:dep-1842"],
    period: "2026-08-14T09:58:00Z",
    status: "correlated"
  },
  {
    label: "Workers price change",
    value: "No price change found",
    source: "get_price_versions",
    recordIds: ["price_versions:price-workers-2026-01"],
    period: "2026-07-01 to 2026-08-31",
    status: "confirmed"
  }
];

const context: NarrativeContext = {
  facts,
  evidence,
  invoiceAppearsCorrect: true,
  confidence: "high",
  rejectGeneratedSections: true
};

const kinds = (prose: string, ctx: NarrativeContext = context) =>
  checkNarrative(prose, ctx).violations.map((v) => v.kind);

describe("evidence-backed prose is accepted", () => {
  it("accepts the wording a real live run produced", () => {
    // Captured verbatim from Workers AI during M4. If the guard rejected this
    // it would be useless: every answer would fall back to boilerplate.
    const real =
      "The August invoice for account abc123 is higher than the July invoice " +
      "due to an increase in workers movement and workers AI movement. The total " +
      "change of $4,820.00 is primarily attributed to the workers movement of " +
      "$4,640.00, with a smaller contribution from workers AI movement of $180.00. " +
      "The usage change occurred on 2026-08-14, around the time of the operational " +
      "event dep-1842, and has been fully accounted for in the invoice.";
    expect(checkNarrative(real, context)).toEqual({ ok: true, violations: [] });
  });

  it("accepts a follow-up that restates a verified finding", () => {
    const answer =
      "No, the usage does not appear to have been duplicated. The duplicate " +
      "usage check found 0 exact and 0 probable duplicates.";
    expect(checkNarrative(answer, context).ok).toBe(true);
  });

  it("accepts amounts that appear only in evidence, not in the fact block", () => {
    expect(kinds("Totals moved from $16,900.00 to $21,720.00.")).toEqual([]);
  });

  it("accepts causal language that is not attributed to an event", () => {
    expect(kinds("The rise was caused by higher request volume.")).toEqual([]);
  });
});

describe("fabricated figures are rejected", () => {
  it("rejects an amount that appears nowhere in evidence", () => {
    expect(kinds("The invoice rose by $99,999.")).toContain("unknown_amount");
  });

  it("rejects an identifier that appears nowhere in evidence", () => {
    expect(kinds("Deployment dep-FAKE is implicated.")).toContain(
      "unknown_identifier"
    );
  });

  it("rejects a percentage that was never computed", () => {
    expect(kinds("Costs rose 73.4% month over month.")).toContain(
      "unknown_percentage"
    );
  });

  it("rejects a date that appears nowhere in evidence", () => {
    expect(kinds("Usage shifted on 2026-08-02.")).toContain("unknown_date");
  });

  it("rejects the exact sentence review demonstrated", () => {
    const lie =
      "The invoice rose by $99,999 because dep-FAKE caused duplicate charges. " +
      "The invoice is correct.";
    const found = kinds(lie);
    expect(found).toContain("unknown_amount");
    expect(found).toContain("unknown_identifier");
    expect(found).toContain("asserted_causation");
  });
});

describe("causation and correctness claims are bounded", () => {
  it("rejects causation asserted for an event", () => {
    expect(kinds("dep-1842 caused the increase.")).toContain(
      "asserted_causation"
    );
    expect(kinds("The rise happened because of dep-1842.")).toContain(
      "asserted_causation"
    );
  });

  it("accepts correlation phrasing for the same event", () => {
    expect(
      kinds(
        "Usage shifted on 2026-08-14, close in time to dep-1842. This is a " +
          "temporal correlation, not proof of cause."
      )
    ).toEqual([]);
  });

  it("rejects a correctness claim when the invoice is not established correct", () => {
    const unresolved = { ...context, invoiceAppearsCorrect: false };
    expect(kinds("The invoice is correct.", unresolved)).toContain(
      "unearned_correctness"
    );
    expect(kinds("The bill appears accurate.", unresolved)).toContain(
      "unearned_correctness"
    );
  });

  it("allows the same claim once the invoice is established correct", () => {
    expect(kinds("The invoice appears correct.")).toEqual([]);
  });

  it("rejects a confidence rating that contradicts the computed one", () => {
    expect(kinds("Confidence: low.")).toContain("confidence_claim");
    expect(kinds("Confidence: high.")).toEqual([]);
  });

  it("rejects prose that writes the deterministically generated sections", () => {
    expect(
      kinds("All good. Recommended next step: no further investigation.")
    ).toContain("wrote_generated_sections");
  });
});

describe("safeNarrative falls back rather than showing partial prose", () => {
  it("returns the fallback when anything is fabricated", () => {
    const result = safeNarrative(
      "The invoice rose by $99,999.",
      "DETERMINISTIC",
      context
    );
    expect(result.usedModel).toBe(false);
    expect(result.text).toBe("DETERMINISTIC");
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("returns the fallback for empty prose", () => {
    const result = safeNarrative("   ", "DETERMINISTIC", context);
    expect(result.usedModel).toBe(false);
    expect(result.text).toBe("DETERMINISTIC");
  });

  it("returns the prose when it is fully evidence-backed", () => {
    const result = safeNarrative(
      "The invoice rose by $4,820.00.",
      "DETERMINISTIC",
      context
    );
    expect(result.usedModel).toBe(true);
    expect(result.text).toBe("The invoice rose by $4,820.00.");
  });

  it("strips a duplicated Finding label without treating it as fabrication", () => {
    const result = safeNarrative(
      "Finding: The invoice rose by $4,820.00.",
      "DETERMINISTIC",
      context
    );
    expect(result.usedModel).toBe(true);
    expect(result.text).toBe("The invoice rose by $4,820.00.");
  });

  it("does not show a sentence that is only partly supported", () => {
    // One good figure does not license the fabricated one beside it.
    const result = safeNarrative(
      "The invoice rose by $4,820.00, of which $99,999 was Workers.",
      "DETERMINISTIC",
      context
    );
    expect(result.usedModel).toBe(false);
  });
});

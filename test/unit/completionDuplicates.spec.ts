import { describe, expect, it } from "vitest";
import { assessCompletion } from "../../src/agent/completion.js";
import { emptyFacts, type InvestigationFacts } from "../../src/agent/facts.js";

/**
 * A duplicate count is only meaningful if the check that produces it ran.
 *
 * `assessCompletion` guards this with `ranDuplicateCheck`, and nothing tested
 * it — a mutation forcing the guard true passed the entire suite. The clause is
 * belt-and-braces (an unrun check also surfaces as a missing diagnostic), but
 * invariant 21 is the one rule in this repo that says exactly this: a check
 * whose inputs are gone has not run, and its absence is never a clean reading.
 *
 * Found while mutation-testing Milestone 9.
 */

const REQUIRED = [
  "get_account_context",
  "compare_invoices",
  "decompose_variance",
  "reconcile_invoice"
];

function facts(over: Partial<InvestigationFacts> = {}): InvestigationFacts {
  return {
    ...emptyFacts(),
    variance_cents: 100_000,
    volume_effect_cents: 100_000,
    price_effect_cents: 0,
    reconciliation_status: "passed",
    explained_percent: 100,
    ...over
  };
}

describe("duplicate counts are only believed when the check ran", () => {
  const metered = ["Workers"];
  const everything = [
    ...REQUIRED,
    "get_usage_timeseries",
    "detect_usage_change_point",
    "get_price_versions:Workers",
    "check_duplicate_usage:Workers"
  ];

  it("reports duplicates as a conflict when the check ran and found some", () => {
    const result = assessCompletion({
      facts: facts({ exact_duplicate_count: 0, probable_duplicate_count: 3 }),
      completedStepIds: everything,
      meteredServices: metered,
      failedTools: []
    });

    expect(result.invoiceAppearsCorrect).toBe(false);
    expect(result.blockers).toContain("3 duplicate usage group(s) found");
    expect(result.confidence).toBe("low");
  });

  it("does not raise a conflict from counts the check never produced", () => {
    // Counts present on the record, but no completed duplicate step: the
    // figures are stale, not fresh. The invoice is still not correct — but
    // because the check is missing, not because a conflict was confirmed.
    const withoutCheck = everything.filter(
      (id) => !id.startsWith("check_duplicate_usage")
    );
    const result = assessCompletion({
      facts: facts({ exact_duplicate_count: 0, probable_duplicate_count: 3 }),
      completedStepIds: withoutCheck,
      meteredServices: metered,
      failedTools: []
    });

    expect(result.invoiceAppearsCorrect).toBe(false);
    expect(result.blockers.join(" ")).toContain(
      "diagnostics not performed: check_duplicate_usage:Workers"
    );
    expect(result.blockers).not.toContain("3 duplicate usage group(s) found");
  });

  it("never reads a missing check as a clean one", () => {
    // The failure that matters most: no duplicate step, zero counts, and the
    // invoice waved through as if duplication had been ruled out.
    const withoutCheck = everything.filter(
      (id) => !id.startsWith("check_duplicate_usage")
    );
    const result = assessCompletion({
      facts: facts({ exact_duplicate_count: null, probable_duplicate_count: null }),
      completedStepIds: withoutCheck,
      meteredServices: metered,
      failedTools: []
    });

    expect(result.invoiceAppearsCorrect).toBe(false);
    expect(result.blockers.join(" ")).toContain("check_duplicate_usage:Workers");
  });

  it("clears duplicates only when the check ran and found none", () => {
    const result = assessCompletion({
      facts: facts({ exact_duplicate_count: 0, probable_duplicate_count: 0 }),
      completedStepIds: everything,
      meteredServices: metered,
      failedTools: []
    });

    expect(result.invoiceAppearsCorrect).toBe(true);
    expect(result.blockers).toEqual([]);
  });
});

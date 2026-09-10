import { evaluateConfidence, type Confidence } from "../domain/confidence.js";
import type { InvestigationFacts } from "../tools/facts.js";
import { REQUIRED_TOOLS } from "./playbooks/invoiceVariance.js";

export const MIN_EXPLAINED_PERCENT = 95;

/**
 * A diagnostic that has not run is not the same as one that ran and found
 * nothing, and completion must not treat it as such. Review showed a model that
 * ended planning immediately still receiving a high-confidence "invoice appears
 * correct" — duplication, pricing, usage shape and operational correlation all
 * unexamined, because only the prelude and reconciliation were ever required
 * and `?? 0` turned an unchecked duplicate count into a clean one.
 *
 * Which diagnostics are required is therefore derived from what the
 * deterministic variance actually shows, not left to the model. PRD §10.5 rule
 * 5: when consumption materially changes, inspect its time series, change
 * point, operational events and possible duplicates.
 */
export function applicableDiagnostics(
  facts: InvestigationFacts,
  /**
   * Metered services on the invoice. Price and duplicate findings are stated
   * invoice-wide, so every metered service has to be checked — review found
   * both hard-coded to Workers, which missed a Workers AI reprice and a
   * Workers AI duplicate while asserting neither existed.
   */
  meteredServices: string[] = []
): string[] {
  const required: string[] = [];
  const perService = (tool: string) =>
    meteredServices.length === 0
      ? [tool]
      : meteredServices.map((service) => `${tool}:${service}`);

  // Any movement at all has to have price ruled in or out, on every service.
  if (facts.variance_cents !== null && facts.variance_cents !== 0) {
    required.push(...perService("get_price_versions"));
  }

  // Consumption moved, so its shape, onset and possible duplication matter.
  if (facts.volume_effect_cents !== null && facts.volume_effect_cents !== 0) {
    required.push("get_usage_timeseries", "detect_usage_change_point");
    required.push(...perService("check_duplicate_usage"));
  }

  // Only meaningful once a change point exists to anchor the window.
  if (facts.change_date !== null) {
    required.push("get_account_events");
  }

  return required;
}

export interface CompletionAssessment {
  invoiceAppearsCorrect: boolean;
  confidence: Confidence;
  confidenceReasons: string[];
  blockers: string[];
}

/**
 * FR-11, evaluated server-side. The model has no input here: it may explain the
 * outcome but cannot produce it, so no amount of confident prose can turn an
 * unreconciled invoice into a correct one.
 */
export function assessCompletion(input: {
  facts: InvestigationFacts;
  completedTools: string[];
  meteredServices?: string[];
  failedTools: string[];
}): CompletionAssessment {
  const { facts, completedTools, failedTools, meteredServices = [] } = input;
  const blockers: string[] = [];

  const missingRequired = REQUIRED_TOOLS.filter(
    (tool) => !completedTools.includes(tool)
  );
  if (missingRequired.length > 0) {
    blockers.push(`required checks did not run: ${missingRequired.join(", ")}`);
  }

  // Diagnostics the variance itself makes applicable. The model chooses the
  // order and may add more, but it cannot decide to skip these.
  const missingDiagnostics = applicableDiagnostics(facts, meteredServices).filter(
    (tool) => !completedTools.includes(tool)
  );
  if (missingDiagnostics.length > 0) {
    blockers.push(
      `diagnostics not performed: ${missingDiagnostics.join(", ")}`
    );
  }
  if (failedTools.length > 0) {
    blockers.push(`checks failed: ${failedTools.join(", ")}`);
  }

  if (facts.reconciliation_status === null) {
    blockers.push("reconciliation did not run");
  } else if (facts.reconciliation_status !== "passed") {
    blockers.push("reconciliation did not pass");
  }

  const explained = facts.explained_percent;
  if (explained === null) {
    blockers.push("variance was not decomposed");
  } else if (explained < MIN_EXPLAINED_PERCENT) {
    blockers.push(
      `only ${explained.toFixed(2)}% of the variance is explained, below the ${MIN_EXPLAINED_PERCENT}% threshold`
    );
  }

  // Only a duplicate check that actually ran can clear duplicates. An
  // unchecked count is absence of evidence, not evidence of absence — it is
  // reported above as a missing diagnostic instead of quietly reading as zero.
  // Matches both the bare tool and its per-service ids.
  const ranDuplicateCheck = completedTools.some(
    (t) => t === "check_duplicate_usage" || t.startsWith("check_duplicate_usage:")
  );
  const duplicatesChecked =
    ranDuplicateCheck &&
    facts.exact_duplicate_count !== null &&
    facts.probable_duplicate_count !== null;
  const duplicates = duplicatesChecked
    ? facts.exact_duplicate_count! + facts.probable_duplicate_count!
    : 0;
  const materialConflict = duplicatesChecked && duplicates > 0;
  if (materialConflict) {
    blockers.push(`${duplicates} duplicate usage group(s) found`);
  }

  const { confidence, reasons } = evaluateConfidence({
    explainedPercent: explained ?? 0,
    reconciliationPassed: facts.reconciliation_status === "passed",
    requiredChecksComplete:
      missingRequired.length === 0 &&
      missingDiagnostics.length === 0 &&
      failedTools.length === 0,
    materialConflict
  });

  return {
    invoiceAppearsCorrect: blockers.length === 0,
    confidence,
    confidenceReasons: reasons,
    blockers
  };
}

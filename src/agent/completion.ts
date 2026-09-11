import { evaluateConfidence, type Confidence } from "../domain/confidence.js";
import type { InvestigationFacts } from "../tools/facts.js";
import { REQUIRED_TOOLS } from "./playbooks/invoiceVariance.js";

export const MIN_EXPLAINED_PERCENT = 95;

/**
 * Which diagnostics this variance makes mandatory, derived from what the
 * deterministic figures show rather than from what the model chose to run.
 *
 * A diagnostic that has not run is not one that ran and found nothing, so an
 * absent result is a blocker here, never a clean reading. PRD §10.5 rule 5;
 * ARCHITECTURE.md §12.
 */
export function applicableDiagnostics(
  facts: InvestigationFacts,
  /**
   * Metered services on the invoice. Price and duplicate findings are stated
   * invoice-wide, so each one is required per service. ARCHITECTURE.md §13.
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
  /** Step ids, not tool names: a per-service check counts only for the service it covered. */
  completedStepIds: string[];
  meteredServices?: string[];
  unverifiedFixedCharges?: string[];
  fixedFeeMovementByService?: Record<string, number>;
  failedTools: string[];
}): CompletionAssessment {
  const { facts, completedStepIds, failedTools, meteredServices = [] } = input;
  const blockers: string[] = [];

  const missingRequired = REQUIRED_TOOLS.filter(
    (id) => !completedStepIds.includes(id)
  );
  if (missingRequired.length > 0) {
    blockers.push(`required checks did not run: ${missingRequired.join(", ")}`);
  }

  // Diagnostics the variance itself makes applicable. The model chooses the
  // order and may add more, but it cannot decide to skip these.
  const missingDiagnostics = applicableDiagnostics(facts, meteredServices).filter(
    (id) => !completedStepIds.includes(id)
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

  // A fixed charge with no authorising record can only be checked for
  // arithmetic consistency, so a charge that *moved* would have "explained"
  // standing in for "valid". Unverifiable movement blocks the claim.
  // ARCHITECTURE.md §14.
  const unverifiableMovement = (input.unverifiedFixedCharges ?? []).filter(
    (service) =>
      (input.fixedFeeMovementByService ?? {})[service] !== undefined &&
      input.fixedFeeMovementByService![service] !== 0
  );
  if (unverifiableMovement.length > 0) {
    blockers.push(
      `fixed charge changed with no authorising record: ${unverifiableMovement.join(", ")}`
    );
  }

  // Only a duplicate check that actually ran can clear duplicates; an unchecked
  // count is reported above as a missing diagnostic rather than read as zero.
  // Matches both the bare tool id and its per-service ids.
  const ranDuplicateCheck = completedStepIds.some(
    (id) => id === "check_duplicate_usage" || id.startsWith("check_duplicate_usage:")
  );
  const duplicatesChecked =
    ranDuplicateCheck &&
    facts.exact_duplicate_count !== null &&
    facts.probable_duplicate_count !== null;
  const duplicateGroupCount = duplicatesChecked
    ? facts.exact_duplicate_count! + facts.probable_duplicate_count!
    : 0;
  const materialConflict = duplicatesChecked && duplicateGroupCount > 0;
  if (materialConflict) {
    blockers.push(`${duplicateGroupCount} duplicate usage group(s) found`);
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

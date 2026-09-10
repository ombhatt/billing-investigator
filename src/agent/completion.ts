import { evaluateConfidence, type Confidence } from "../domain/confidence.js";
import type { InvestigationFacts } from "../tools/facts.js";
import { REQUIRED_TOOLS } from "./playbooks/invoiceVariance.js";

export const MIN_EXPLAINED_PERCENT = 95;

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
  failedTools: string[];
}): CompletionAssessment {
  const { facts, completedTools, failedTools } = input;
  const blockers: string[] = [];

  const missingRequired = REQUIRED_TOOLS.filter(
    (tool) => !completedTools.includes(tool)
  );
  if (missingRequired.length > 0) {
    blockers.push(`required checks did not run: ${missingRequired.join(", ")}`);
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

  // A duplicate that the invoice also bills is a contradiction between sources.
  const duplicates =
    (facts.exact_duplicate_count ?? 0) + (facts.probable_duplicate_count ?? 0);
  const materialConflict = duplicates > 0;
  if (materialConflict) {
    blockers.push(`${duplicates} duplicate usage group(s) found`);
  }

  const { confidence, reasons } = evaluateConfidence({
    explainedPercent: explained ?? 0,
    reconciliationPassed: facts.reconciliation_status === "passed",
    requiredChecksComplete: missingRequired.length === 0 && failedTools.length === 0,
    materialConflict
  });

  return {
    invoiceAppearsCorrect: blockers.length === 0,
    confidence,
    confidenceReasons: reasons,
    blockers
  };
}

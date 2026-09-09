export type Confidence = "high" | "medium" | "low";

export interface ConfidenceInput {
  explainedPercent: number;
  reconciliationPassed: boolean;
  requiredChecksComplete: boolean;
  /** A contradiction between sources, e.g. a duplicate that the invoice bills. */
  materialConflict: boolean;
  /** Non-critical sources that could not be read this run. */
  unavailableSources?: number;
}

export interface ConfidenceResult {
  confidence: Confidence;
  reasons: string[];
}

/**
 * PRD §12.10. Deterministic by design: the LLM may explain this rating but
 * cannot change it, so it must be computable without the model.
 */
export function evaluateConfidence(input: ConfidenceInput): ConfidenceResult {
  const {
    explainedPercent,
    reconciliationPassed,
    requiredChecksComplete,
    materialConflict,
    unavailableSources = 0
  } = input;

  const reasons: string[] = [];

  if (materialConflict) {
    reasons.push("material conflict between sources");
    return { confidence: "low", reasons };
  }
  if (explainedPercent < 70) {
    reasons.push(`only ${explainedPercent.toFixed(2)}% of variance explained`);
    return { confidence: "low", reasons };
  }

  if (
    explainedPercent >= 95 &&
    reconciliationPassed &&
    requiredChecksComplete &&
    unavailableSources === 0
  ) {
    reasons.push(`${explainedPercent.toFixed(2)}% of variance explained`);
    reasons.push("reconciliation passed at every boundary");
    reasons.push("all required checks complete");
    return { confidence: "high", reasons };
  }

  if (explainedPercent < 95) {
    reasons.push(`${explainedPercent.toFixed(2)}% of variance explained`);
  }
  if (!reconciliationPassed) reasons.push("reconciliation did not pass");
  if (!requiredChecksComplete) reasons.push("required checks incomplete");
  if (unavailableSources > 0) {
    reasons.push(`${unavailableSources} source(s) unavailable`);
  }
  return { confidence: "medium", reasons };
}

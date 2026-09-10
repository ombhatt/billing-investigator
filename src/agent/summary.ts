import { formatUsd } from "../domain/money.js";
import type { EvidenceCard } from "../types/tools.js";
import type { InvestigationFacts } from "../tools/facts.js";
import type { CompletionAssessment } from "./completion.js";
import type { FinalSummary } from "./types.js";

/**
 * Built from facts alone, with no model involved. Used when synthesis fails
 * (PRD §8.5, §19) and as the shape the model is asked to phrase.
 *
 * Every number here comes from a tool result. Nothing is inferred.
 */
export function deterministicSummary(
  facts: InvestigationFacts,
  evidence: EvidenceCard[],
  assessment: CompletionAssessment,
  periods: { currentPeriod: string; comparisonPeriod: string }
): FinalSummary {
  const variance = facts.variance_cents;
  const direction = variance === null ? "changed" : variance >= 0 ? "increased" : "decreased";

  const finding =
    variance === null
      ? `The ${periods.currentPeriod} invoice could not be compared with ${periods.comparisonPeriod}.`
      : `The ${periods.currentPeriod} invoice ${direction} by ${formatUsd(Math.abs(variance))}` +
        (facts.percentage_variance_display !== null
          ? ` (${facts.percentage_variance_display}%)`
          : "") +
        `, from ${formatUsd(facts.comparison_total_cents ?? 0)} to ${formatUsd(facts.current_total_cents ?? 0)}.`;

  const lines: string[] = [];
  if (facts.workers_variance_cents) {
    lines.push(`Workers accounts for ${formatUsd(facts.workers_variance_cents)}.`);
  }
  if (facts.workers_ai_variance_cents) {
    lines.push(
      `Workers AI accounts for ${formatUsd(facts.workers_ai_variance_cents)}.`
    );
  }
  if (facts.price_changed === false) {
    lines.push("Contract pricing did not change between the two periods.");
  } else if (facts.price_changed === true) {
    lines.push("Contract pricing changed between the two periods.");
  }
  if (facts.change_date) {
    lines.push(
      facts.correlated_event_id
        ? `Usage shifted on ${facts.change_date}, close in time to ${facts.correlated_event_id}. This is a temporal correlation, not proof of cause.`
        : `Usage shifted on ${facts.change_date}.`
    );
  }
  if (
    facts.exact_duplicate_count !== null &&
    facts.probable_duplicate_count !== null
  ) {
    lines.push(
      facts.exact_duplicate_count === 0 && facts.probable_duplicate_count === 0
        ? "No exact or probable duplicate usage was found."
        : `${facts.exact_duplicate_count} exact and ${facts.probable_duplicate_count} probable duplicate groups were found.`
    );
  }
  if (facts.reconciliation_status) {
    lines.push(
      facts.reconciliation_status === "passed"
        ? "Raw usage, rated charges and invoice lines reconcile to the cent."
        : "Reconciliation did not pass at every boundary."
    );
  }
  if (facts.explained_percent !== null) {
    lines.push(`${facts.explained_percent.toFixed(2)}% of the variance is explained.`);
  }

  const assessmentText = assessment.invoiceAppearsCorrect
    ? `The invoice appears correct on the available evidence. Confidence: ${assessment.confidence}. This is an operational assessment, not a financial certification.`
    : `The investigation is unresolved. Confidence: ${assessment.confidence}. Outstanding: ${assessment.blockers.join("; ")}.`;

  const recommendedNextStep = assessment.invoiceAppearsCorrect
    ? facts.correlated_event_id
      ? `Confirm with the application owner whether the traffic following ${facts.correlated_event_id} was expected.`
      : "Share the variance breakdown with the customer."
    : `Resolve the outstanding items before responding: ${assessment.blockers.join("; ")}.`;

  return {
    finding,
    evidence: lines,
    assessment: assessmentText,
    recommendedNextStep,
    invoiceAppearsCorrect: assessment.invoiceAppearsCorrect,
    generatedBy: "deterministic_fallback"
  };
}

/** Renders a summary as the Finding / Evidence / Assessment / Next step block. */
export function renderSummary(summary: FinalSummary): string {
  return [
    `**Finding.** ${summary.finding}`,
    "",
    "**Evidence.**",
    ...summary.evidence.map((line) => `- ${line}`),
    "",
    `**Assessment.** ${summary.assessment}`,
    "",
    `**Recommended next step.** ${summary.recommendedNextStep}`
  ].join("\n");
}

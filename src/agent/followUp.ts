import type { ModelClient } from "./modelClient.js";
import { safeNarrative } from "./narrativeGuard.js";
import { renderSummary } from "./summary.js";
import type { InvestigationRecord } from "./types.js";

/**
 * Answers a follow-up from evidence already persisted on the investigation.
 *
 * P0 deliberately runs no new tools here: every question in PRD §7.4 is
 * answerable from the evidence the first turn gathered, and re-running a tool
 * would spend budget to re-derive a fact already on the record. If the evidence
 * genuinely does not cover the question, the answer says so rather than
 * guessing.
 */
export async function answerFollowUp(
  record: InvestigationRecord,
  question: string,
  model: ModelClient
): Promise<{ text: string; usedEvidenceCount: number }> {
  if (record.evidence.length === 0 || record.summary === null) {
    return {
      text: "No investigation has completed yet, so there is no evidence to draw on. Ask the original question first.",
      usedEvidenceCount: 0
    };
  }

  try {
    const prose = await model.explain({
      question,
      facts: record.facts,
      evidence: record.evidence,
      hypotheses: record.hypotheses,
      invoiceAppearsCorrect: record.summary.invoiceAppearsCorrect,
      blockers: record.blockers,
      mode: "follow_up"
    });
    // Follow-ups are held to the same boundary as the summary: a fabricated
    // figure is no less damaging for arriving in the second answer.
    const narrative = safeNarrative(prose, renderSummary(record.summary), {
      facts: record.facts,
      evidence: record.evidence,
      invoiceAppearsCorrect: record.summary.invoiceAppearsCorrect,
      confidence: record.facts.confidence,
      periods: [record.currentPeriod, record.comparisonPeriod].filter(
        (p): p is string => p !== null
      )
    });
    if (narrative.usedModel) {
      return {
        text: narrative.text,
        usedEvidenceCount: record.evidence.length
      };
    }
  } catch {
    // Fall through to the persisted summary.
  }

  return {
    text: renderSummary(record.summary),
    usedEvidenceCount: record.evidence.length
  };
}

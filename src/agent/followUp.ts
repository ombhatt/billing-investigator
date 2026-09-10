import type { ModelClient } from "./modelClient.js";
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
    if (prose.trim().length > 0) {
      return { text: prose.trim(), usedEvidenceCount: record.evidence.length };
    }
  } catch {
    // Fall through to the persisted summary.
  }

  return {
    text: renderSummary(record.summary),
    usedEvidenceCount: record.evidence.length
  };
}

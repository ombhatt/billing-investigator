import type { ModelClient } from "./modelClient.js";
import { safeNarrative } from "./narrativeGuard.js";
import { periodsMentioned } from "../domain/period.js";
import { renderSummary } from "./summary.js";
import type { FinalSummary, InvestigationRecord } from "./types.js";

/**
 * Answers a follow-up from evidence already persisted on the investigation.
 *
 * P0 runs no new tools here. PRD §7.4 permits a re-call when different
 * granularity is needed, and the honest reading of that permission is that the
 * evidence should have been sufficient in the first place — so the sufficiency
 * is arranged during the investigation rather than repaired afterwards.
 *
 * Review showed the claim was not true as written. "Which zone generated the
 * increase?" is required by §7.4, and the persisted evidence held August's zone
 * totals only: the primary zone's 83% share of the period was the nearest
 * available number and it is not the answer — that zone drove 96% of the
 * growth. The model could only guess or decline. `get_usage_timeseries` now
 * computes the per-zone comparison during the investigation, so the follow-up
 * reads a figure rather than inferring one.
 *
 * If the evidence genuinely does not cover a question, the answer says so
 * rather than guessing.
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

  const investigated = [record.currentPeriod, record.comparisonPeriod].filter(
    (p): p is string => p !== null
  );

  // A question about a month this investigation never looked at cannot be
  // answered from its evidence, and must not be answered from its conclusion.
  // "What about June?" previously returned the August-versus-July summary
  // verbatim, which reads as an answer and is not one.
  const outside = periodsOutsideInvestigation(question, investigated);
  if (outside.length > 0) {
    return {
      text:
        `This investigation compared ${investigated.join(" and ")}, so I have no evidence for ` +
        `${outside.join(" or ")}. Reset the demo and ask about ${outside[0]} to investigate it.`,
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
    const narrative = safeNarrative(prose, unanswered(record.summary), {
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
    // Fall through to the labelled fallback below.
  }

  return {
    text: unanswered(record.summary),
    usedEvidenceCount: record.evidence.length
  };
}

/**
 * Periods a question asks about that the investigation did not cover.
 *
 * The year is taken from the investigated periods, because a follow-up saying
 * "the month of June" means June of the year under investigation and naming no
 * year is the normal way to ask. Where the investigation spans two years both
 * are considered, so a month belonging to either is not reported as outside.
 */
function periodsOutsideInvestigation(
  question: string,
  investigated: string[]
): string[] {
  if (investigated.length === 0) return [];

  const years = [...new Set(investigated.map((p) => Number(p.slice(0, 4))))];
  const asked = new Set<string>();
  for (const year of years) {
    for (const period of periodsMentioned(question, year)) asked.add(period);
  }

  return [...asked].filter((p) => !investigated.includes(p)).sort();
}

/**
 * The reply when the question could not be answered from the evidence.
 *
 * It must not be the summary alone. Returning `renderSummary` here meant a
 * question the agent could not answer received the previous conclusion,
 * formatted exactly like an answer — the reader has no way to tell the
 * difference. Saying so first costs one sentence and removes the ambiguity.
 */
function unanswered(summary: FinalSummary): string {
  return [
    "I could not answer that from the evidence on record. Here is what this investigation established:",
    "",
    renderSummary(summary)
  ].join("\n");
}

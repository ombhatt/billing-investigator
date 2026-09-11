import { formatUsd } from "../domain/money.js";
import { periodsMentionedWithin } from "../domain/period.js";
import type { EvidenceCard } from "../types/tools.js";
import type { InvestigationFacts } from "../tools/facts.js";

/**
 * The model writes the prose a billing operator actually reads. Structured
 * facts staying correct is not enough: a fabricated sentence sitting above a
 * correct fact table is still a wrong answer, and it is the sentence that gets
 * pasted into a customer email.
 *
 * Review demonstrated all four failure kinds passing through unchanged:
 *
 *   "The invoice rose by $99,999 because dep-FAKE caused duplicate charges.
 *    The invoice is correct."
 *
 * an amount not in evidence, an identifier not in evidence, causation asserted
 * for an event, and a correctness claim the model is not entitled to make.
 *
 * The rule enforced here: **the model may only restate figures and identifiers
 * that already appear in verified evidence.** It chooses what to say and how to
 * phrase it; it does not get to introduce new facts.
 */

export type NarrativeViolation =
  | { kind: "unknown_amount"; value: string }
  | { kind: "unknown_identifier"; value: string }
  | { kind: "unknown_percentage"; value: string }
  | { kind: "unknown_date"; value: string }
  | { kind: "unknown_period"; value: string }
  | { kind: "asserted_causation"; value: string }
  | { kind: "unearned_correctness"; value: string }
  | { kind: "confidence_claim"; value: string }
  | { kind: "wrote_generated_sections"; value: string };

export interface NarrativeCheck {
  ok: boolean;
  violations: NarrativeViolation[];
}

const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?/g;
const PERCENT = /\d+(?:\.\d+)?\s?%/g;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/** Record identifiers in this domain are all `prefix-suffix`. */
const IDENTIFIER = /\b(?:dep|cfg|inv|rc|ue|price|zone|sub)-[A-Za-z0-9_-]+\b/gi;

/** Causal verbs. Proximity to an event id is what makes them a violation. */
const CAUSAL =
  /\b(?:caused?|causing|because of|as a result of|resulted in|led to|triggered)\b/i;
const CORRECTNESS =
  /\b(?:invoice|bill|charges?)\b[^.]{0,40}\b(?:is|are|appears?|looks?)\b[^.]{0,20}\b(?:correct|accurate|right|valid)\b/i;
const CONFIDENCE = /\bconfidence\b[^.]{0,30}?\b(high|medium|low)\b/i;

function normaliseAmount(value: string): string {
  return value.replace(/\s/g, "").replace(/\.00$/, "");
}

/**
 * Everything the model is permitted to restate, drawn from the fact block and
 * the evidence cards the tools produced.
 */
function allowedVocabulary(
  facts: InvestigationFacts,
  evidence: EvidenceCard[]
): {
  amounts: Set<string>;
  percentages: Set<string>;
  dates: Set<string>;
  identifiers: Set<string>;
} {
  const evidenceText = evidence
    .map((c) => `${c.label} ${c.value} ${c.recordIds.join(" ")} ${c.period ?? ""}`)
    .join(" ");

  const amounts = new Set<string>();
  const percentages = new Set<string>();
  const dates = new Set<string>();
  const identifiers = new Set<string>();

  // Currency facts, in the form the model is shown them.
  for (const cents of [
    facts.current_total_cents,
    facts.comparison_total_cents,
    facts.variance_cents,
    facts.workers_variance_cents,
    facts.workers_ai_variance_cents
  ]) {
    if (cents === null) continue;
    amounts.add(normaliseAmount(formatUsd(cents)));
    amounts.add(normaliseAmount(formatUsd(Math.abs(cents))));
  }

  if (facts.percentage_variance_display !== null) {
    percentages.add(`${facts.percentage_variance_display}%`);
  }
  if (facts.explained_percent !== null) {
    percentages.add(`${facts.explained_percent}%`);
    percentages.add(`${facts.explained_percent.toFixed(2)}%`);
  }
  if (facts.change_date) dates.add(facts.change_date);
  if (facts.correlated_event_id) identifiers.add(facts.correlated_event_id.toLowerCase());

  // Anything a tool already put in front of the reader is fair to restate.
  for (const match of evidenceText.match(AMOUNT) ?? []) {
    amounts.add(normaliseAmount(match));
  }
  for (const match of evidenceText.match(PERCENT) ?? []) {
    percentages.add(match.replace(/\s/g, ""));
  }
  for (const match of evidenceText.match(ISO_DATE) ?? []) dates.add(match);
  for (const match of evidenceText.match(IDENTIFIER) ?? []) {
    identifiers.add(match.toLowerCase());
  }

  return { amounts, percentages, dates, identifiers };
}

export interface NarrativeContext {
  facts: InvestigationFacts;
  evidence: EvidenceCard[];
  invoiceAppearsCorrect: boolean;
  /** When set, the prose must not contradict the computed rating. */
  confidence?: string | null;
  /**
   * The periods actually investigated. Prose naming any other month is
   * describing an invoice that was never looked at.
   */
  periods?: string[];
  /** Summary prose must not write the deterministically generated sections. */
  rejectGeneratedSections?: boolean;
}

export function checkNarrative(
  prose: string,
  context: NarrativeContext
): NarrativeCheck {
  const violations: NarrativeViolation[] = [];
  const vocabulary = allowedVocabulary(context.facts, context.evidence);

  for (const match of prose.match(AMOUNT) ?? []) {
    if (!vocabulary.amounts.has(normaliseAmount(match))) {
      violations.push({ kind: "unknown_amount", value: match });
    }
  }
  for (const match of prose.match(PERCENT) ?? []) {
    if (!vocabulary.percentages.has(match.replace(/\s/g, ""))) {
      violations.push({ kind: "unknown_percentage", value: match });
    }
  }
  for (const match of prose.match(ISO_DATE) ?? []) {
    if (!vocabulary.dates.has(match)) {
      violations.push({ kind: "unknown_date", value: match });
    }
  }
  for (const match of prose.match(IDENTIFIER) ?? []) {
    if (!vocabulary.identifiers.has(match.toLowerCase())) {
      violations.push({ kind: "unknown_identifier", value: match });
    }
  }

  // Which months the answer is *about*, not just the digits in it.
  //
  // Every figure can be correct and the answer still be wrong: "The May invoice
  // jumped by $4,820.00" over August's data fabricates nothing above and is
  // false in the one way that matters most — it names the wrong invoice.
  //
  // The year is inferred from the periods investigated, so a bare "the May
  // invoice" is caught and not only "May 2026". Reading the prose without a
  // year to assume made every bare month name invisible here.
  if (context.periods && context.periods.length > 0) {
    const investigated = new Set(context.periods);
    for (const period of periodsMentionedWithin(prose, context.periods)) {
      if (!investigated.has(period)) {
        violations.push({ kind: "unknown_period", value: period });
      }
    }
  }

  // Causation is judged per sentence: "usage rose because demand grew" is fine,
  // "usage rose because dep-1842 caused it" is not. PRD §12.8.
  for (const sentence of prose.split(/(?<=[.!?])\s+/)) {
    if (CAUSAL.test(sentence) && IDENTIFIER.test(sentence)) {
      IDENTIFIER.lastIndex = 0;
      violations.push({ kind: "asserted_causation", value: sentence.trim() });
    }
    IDENTIFIER.lastIndex = 0;
  }

  if (!context.invoiceAppearsCorrect) {
    const claim = prose.match(CORRECTNESS);
    if (claim) {
      violations.push({ kind: "unearned_correctness", value: claim[0] });
    }
  }

  if (context.confidence) {
    const claim = prose.match(CONFIDENCE);
    if (claim && claim[1].toLowerCase() !== context.confidence.toLowerCase()) {
      violations.push({ kind: "confidence_claim", value: claim[0] });
    }
  }

  if (context.rejectGeneratedSections) {
    if (/recommended next step|assessment\s*:/i.test(prose)) {
      violations.push({
        kind: "wrote_generated_sections",
        value: "prose contains sections generated deterministically"
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Returns the model's prose when it is evidence-backed, otherwise the
 * deterministic text. Never returns partially-trusted prose: a single
 * fabricated figure discredits the sentence it sits in.
 */
export function safeNarrative(
  prose: string,
  fallback: string,
  context: NarrativeContext
): { text: string; usedModel: boolean; violations: NarrativeViolation[] } {
  const trimmed = prose
    .trim()
    .replace(/^\**\s*Finding\s*[:.]\s*/i, "")
    .trim();

  if (trimmed.length === 0) {
    return { text: fallback, usedModel: false, violations: [] };
  }

  const check = checkNarrative(trimmed, context);
  if (!check.ok) {
    return { text: fallback, usedModel: false, violations: check.violations };
  }
  return { text: trimmed, usedModel: true, violations: [] };
}

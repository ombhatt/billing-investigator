import { periodsMentioned } from "../domain/period.js";
import { isFailure } from "../types/tools.js";
import type { CaseClassification, ModelClient } from "./modelClient.js";
import { transition } from "./stateMachine.js";
import type { ToolExecutor } from "./toolExecution.js";
import type { InvestigationRecord } from "./types.js";

/**
 * Which two periods this investigation compares, and what to ask when that
 * cannot be settled.
 *
 * Extracted from the coordinator because it changes for entirely different
 * reasons than sequencing does: how a question is read, what a clarification
 * reply means, how an unavailable month is reported. Three separate defects
 * have lived in here, and all three were about interpreting a request rather
 * than about running a playbook.
 */

export const DEFAULT_CLARIFICATION =
  "Which two billing periods should I compare for this account?";

function listPeriods(periods: string[]): string {
  return [...periods].sort().join(", ");
}

/**
 * Billing periods a piece of user text names.
 *
 * The year is inferred from the account's own invoices where the text omits
 * one, because "August versus July" is how the question is actually asked. Only
 * years the account has invoices in are tried, so an omitted year can never
 * invent a period out of range.
 */
export function periodsNamed(text: string, available: string[]): string[] {
  const years = [...new Set(available.map((p) => Number(p.slice(0, 4))))];
  const found = new Set<string>(periodsMentioned(text));
  for (const year of years) {
    for (const period of periodsMentioned(text, year)) found.add(period);
  }
  return [...found].sort();
}

/** Reads as one request: the reply alone does not say what was being asked. */
export function clarificationContext(
  record: InvestigationRecord,
  reply: string
): string {
  return [
    `Original request: ${record.originalQuestion ?? ""}`.trim(),
    `Clarification asked: ${record.clarificationQuestion ?? DEFAULT_CLARIFICATION}`,
    `Answer: ${reply}`
  ].join("\n");
}

export type PeriodChoice =
  | { currentPeriod: string; comparisonPeriod: string }
  | { clarify: string };

/**
 * Which two periods to compare, or what to ask.
 *
 * Three rules, learned in this order:
 *
 * 1. A pair the reader named explicitly is used as given. Checking only that
 *    the model's periods *exist* was not enough — told "2026-06 and 2026-07",
 *    the live model answered with 2026-07 and 2026-08, both available, and the
 *    agent investigated a pair nobody asked for.
 * 2. A requested period the account does not have is *reported*, never quietly
 *    swapped for the newest invoice. Substituting turned "why did May jump?"
 *    into a confident answer about August.
 * 3. Falling back to the two most recent invoices survives in exactly one
 *    case: the model could not be reached at all, so nothing was requested and
 *    nothing is being overridden.
 */
export function resolvePeriods(
  classification: CaseClassification | null,
  periods: string[],
  requested: string[]
): PeriodChoice {
  const sorted = [...periods].sort();

  if (periods.length < 2) {
    return {
      clarify:
        periods.length === 0
          ? "I have no invoices for this account, so there is nothing to compare."
          : `I only have one invoice for this account (${sorted[0]}), so there is nothing to compare it with.`
    };
  }

  if (requested.length === 2) {
    return { currentPeriod: requested[1], comparisonPeriod: requested[0] };
  }
  if (requested.length > 2) {
    return {
      clarify:
        `That names ${requested.length} periods (${requested.join(", ")}). ` +
        "Which two should I compare?"
    };
  }

  if (!classification) {
    return { currentPeriod: sorted.at(-1)!, comparisonPeriod: sorted.at(-2)! };
  }

  if (classification.needsClarification) {
    return {
      clarify: classification.clarificationQuestion ?? DEFAULT_CLARIFICATION
    };
  }

  const modelPeriods = [classification.currentPeriod, classification.comparisonPeriod];
  const missing = [...new Set(modelPeriods.filter((p) => !periods.includes(p)))];
  if (missing.length > 0) {
    return {
      clarify:
        `I do not have ${missing.join(" or ")} for this account. ` +
        `Available periods are ${listPeriods(periods)}. Which two should I compare?`
    };
  }

  if (classification.currentPeriod === classification.comparisonPeriod) {
    return {
      clarify:
        `That names ${classification.currentPeriod} twice. ` +
        `Available periods are ${listPeriods(periods)}. Which two should I compare?`
    };
  }

  return {
    currentPeriod: classification.currentPeriod,
    comparisonPeriod: classification.comparisonPeriod
  };
}

export interface ClassifyDeps {
  executor: ToolExecutor;
  model: ModelClient;
}

/**
 * Classify and pin down the periods, or return the record still waiting.
 *
 * `question` is what the model reads; `provenance` is the request to remember,
 * so a clarification round trip keeps the original rather than storing the
 * synthesised context as though the user had typed it. `userText` is only ever
 * this turn's message — the synthesised context still quotes the original
 * request, so parsing that would re-raise the same objection forever and the
 * reader could never answer it.
 */
export async function classifyPeriods(
  record: InvestigationRecord,
  question: string,
  provenance: string,
  userText: string,
  deps: ClassifyDeps
): Promise<InvestigationRecord> {
  const outcome = await deps.executor.execute("get_account_context", {
    accountId: record.accountId
  });
  const periods =
    outcome.result === null || isFailure(outcome.result)
      ? []
      : outcome.result.data.availableInvoices.map((i) => i.period);

  const metrics = {
    ...record.metrics,
    toolCalls: deps.executor.toolCalls,
    cachedToolCalls: deps.executor.cachedToolCalls
  };

  // Checked against what the reader actually typed, before the model is asked.
  // Validating only the model's answer is not enough: shown the available
  // periods, the live model quietly answers with those instead of the months it
  // was asked about, so the substitution happens before any check can see it.
  const asked = periodsNamed(userText, periods);
  if (periods.length > 0) {
    const unavailable = asked.filter((p) => !periods.includes(p));
    if (unavailable.length > 0) {
      return {
        ...record,
        metrics,
        originalQuestion: record.originalQuestion ?? provenance,
        state: transition(record.state, "clarification_required"),
        clarificationQuestion:
          `I have no invoice for ${unavailable.join(" or ")} on this account. ` +
          `Available periods are ${listPeriods(periods)}. Which two should I compare?`
      };
    }
  }

  let classification: CaseClassification | null;
  try {
    classification = await deps.model.classify({
      question,
      boundAccountId: record.accountId,
      availablePeriods: periods
    });
  } catch {
    classification = null;
  }

  // The account is never taken from the model: the investigation is bound to
  // one account server-side and a model-supplied id cannot widen that.
  const choice = resolvePeriods(
    classification,
    periods,
    asked.filter((p) => periods.includes(p))
  );
  const remembered = record.originalQuestion ?? provenance;

  if ("clarify" in choice) {
    return {
      ...record,
      metrics,
      originalQuestion: remembered,
      state: transition(record.state, "clarification_required"),
      clarificationQuestion: choice.clarify
    };
  }

  return {
    ...record,
    metrics,
    caseType: "invoice_variance",
    originalQuestion: remembered,
    currentPeriod: choice.currentPeriod,
    comparisonPeriod: choice.comparisonPeriod,
    clarificationQuestion: null,
    state: transition(record.state, "planning")
  };
}

import { periodsMentioned } from "../domain/period.js";
import { billingPeriod, type BillingPeriod } from "../domain/units.js";
import { isFailure } from "../types/tools.js";
import type { CaseClassification, ModelClient } from "./modelClient.js";
import { transition } from "./stateMachine.js";
import type { ToolExecutor } from "./toolExecution.js";
import type { InvestigationRecord } from "./types.js";

/**
 * Which two periods this investigation compares, and what to ask when that
 * cannot be settled.
 *
 * Separate from the coordinator because it changes for different reasons than
 * sequencing does: how a question is read, what a clarification reply means,
 * how an unavailable month is reported. ARCHITECTURE.md §17, §20.
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
export function periodsNamed(text: string, available: string[]): BillingPeriod[] {
  const years = [...new Set(available.map((p) => Number(p.slice(0, 4))))];
  const found = new Set<BillingPeriod>(periodsMentioned(text));
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
  | { currentPeriod: BillingPeriod; comparisonPeriod: BillingPeriod }
  | { clarify: string };

/**
 * Which two periods to compare, or what to ask. Three rules, in precedence
 * order (ARCHITECTURE.md §20):
 *
 * 1. Periods the reader named explicitly win over the model's selection. The
 *    model's pair being *available* is not sufficient — it may be available and
 *    still not the pair that was asked about.
 * 2. A requested period the account does not have is reported, never
 *    substituted with the newest invoice.
 * 3. The two most recent invoices are a fallback for one case only: the model
 *    was unreachable, so nothing was requested and nothing is being overridden.
 */
export function resolvePeriods(
  classification: CaseClassification | null,
  availablePeriods: string[],
  requested: BillingPeriod[]
): PeriodChoice {
  const sorted = [...availablePeriods].sort();

  if (availablePeriods.length < 2) {
    return {
      clarify:
        availablePeriods.length === 0
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
    return {
      currentPeriod: billingPeriod(sorted.at(-1)!),
      comparisonPeriod: billingPeriod(sorted.at(-2)!)
    };
  }

  if (classification.needsClarification) {
    return {
      clarify: classification.clarificationQuestion ?? DEFAULT_CLARIFICATION
    };
  }

  const modelPeriods = [classification.currentPeriod, classification.comparisonPeriod];
  const missing = [...new Set(modelPeriods.filter((p) => !availablePeriods.includes(p)))];
  if (missing.length > 0) {
    return {
      clarify:
        `I do not have ${missing.join(" or ")} for this account. ` +
        `Available periods are ${listPeriods(availablePeriods)}. Which two should I compare?`
    };
  }

  if (classification.currentPeriod === classification.comparisonPeriod) {
    return {
      clarify:
        `That names ${classification.currentPeriod} twice. ` +
        `Available periods are ${listPeriods(availablePeriods)}. Which two should I compare?`
    };
  }

  // The model supplies these as plain strings. They are validated here, at the
  // one place untrusted input becomes a domain value.
  return {
    currentPeriod: billingPeriod(classification.currentPeriod, "requested period"),
    comparisonPeriod: billingPeriod(
      classification.comparisonPeriod,
      "comparison period"
    )
  };
}

export interface ClassifyDeps {
  executor: ToolExecutor;
  model: ModelClient;
}

/**
 * Three views of the same turn, which are only identical on the opening
 * question. On a clarification reply they differ, and passing the wrong one
 * reintroduces a defect this module has already had.
 */
export interface ClassificationRequest {
  /** What the model reads. On a clarification reply, the synthesised context. */
  modelQuestion: string;
  /** The request to remember as the investigation's own, across round trips. */
  originalQuestion: string;
  /**
   * This turn's message alone, and never the synthesised context — which quotes
   * the original request, so parsing it would re-raise an objection about a
   * period the reader has just been asked to replace.
   */
  userReply: string;
}

/** Classify and pin down the periods, or return the record still waiting. */
export async function classifyPeriods(
  record: InvestigationRecord,
  request: ClassificationRequest,
  deps: ClassifyDeps
): Promise<InvestigationRecord> {
  const { modelQuestion, originalQuestion, userReply } = request;
  const outcome = await deps.executor.execute("get_account_context", {
    accountId: record.accountId
  });
  const availablePeriods =
    outcome.result === null || isFailure(outcome.result)
      ? []
      : outcome.result.data.availableInvoices.map((i) => i.period);

  const metrics = {
    ...record.metrics,
    toolCalls: deps.executor.toolCalls,
    cachedToolCalls: deps.executor.cachedToolCalls
  };

  // Read from what the reader typed, before the model is asked. A model shown
  // the available periods may answer with those rather than the months in the
  // question, so checking only its answer cannot detect the substitution.
  const asked = periodsNamed(userReply, availablePeriods);
  if (availablePeriods.length > 0) {
    const unavailable = asked.filter((p) => !availablePeriods.includes(p));
    if (unavailable.length > 0) {
      return {
        ...record,
        metrics,
        originalQuestion: record.originalQuestion ?? originalQuestion,
        state: transition(record.state, "clarification_required"),
        clarificationQuestion:
          `I have no invoice for ${unavailable.join(" or ")} on this account. ` +
          `Available periods are ${listPeriods(availablePeriods)}. Which two should I compare?`
      };
    }
  }

  let classification: CaseClassification | null;
  try {
    classification = await deps.model.classify({
      question: modelQuestion,
      boundAccountId: record.accountId,
      availablePeriods
    });
  } catch {
    classification = null;
  }

  // The account is never taken from the model: the investigation is bound to
  // one account server-side and a model-supplied id cannot widen that.
  const choice = resolvePeriods(
    classification,
    availablePeriods,
    asked.filter((p) => availablePeriods.includes(p))
  );
  const remembered = record.originalQuestion ?? originalQuestion;

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

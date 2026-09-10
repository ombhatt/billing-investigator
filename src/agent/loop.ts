import { periodEnd, periodsMentioned, periodStart } from "../domain/period.js";
import { applyToolFacts, emptyFacts } from "../tools/facts.js";
import type { ToolRunner } from "../tools/registry.js";
import { isFailure, type ToolResult } from "../types/tools.js";
import { applicableDiagnostics, assessCompletion } from "./completion.js";
import type {
  CaseClassification,
  ModelClient,
  PlanUpdate
} from "./modelClient.js";
import { planUpdateSchema } from "./modelClient.js";
import { safeNarrative } from "./narrativeGuard.js";
import {
  CONDITIONAL_STEPS,
  initialHypotheses,
  initialPlan,
  isConditionalTool,
  MAX_PLANNING_CYCLES_PER_TURN,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_RETRIES,
  REQUIRED_PRELUDE,
  REQUIRED_RECONCILIATION
} from "./playbooks/invoiceVariance.js";
import { isTerminal, transition } from "./stateMachine.js";
import { deterministicSummary } from "./summary.js";
import type {
  InvestigationRecord,
  PlanStep,
  ServiceEffectSummary,
  StepStatus
} from "./types.js";

export interface LoopDeps {
  runner: ToolRunner;
  model: ModelClient;
  focusService: string;
}

export function newInvestigation(
  investigationId: string,
  accountId: string,
  focusService: string
): InvestigationRecord {
  return {
    investigationId,
    accountId,
    caseType: null,
    currentPeriod: null,
    comparisonPeriod: null,
    focusService,
    serviceEffects: [],
    unverifiedFixedCharges: [],
    state: "created",
    originalQuestion: null,
    clarificationQuestion: null,
    plan: initialPlan(),
    hypotheses: initialHypotheses(),
    evidence: [],
    facts: emptyFacts(),
    summary: null,
    metrics: {
      toolCalls: 0,
      cachedToolCalls: 0,
      planningCycles: 0,
      startedAt: new Date().toISOString(),
      completedAt: null
    },
    blockers: []
  };
}

/** Steps are addressed by id, which for per-service steps includes the service. */
export function stepId(tool: string, service?: string): string {
  return service === undefined ? tool : `${tool}:${service}`;
}

function setStep(
  plan: PlanStep[],
  id: string,
  status: StepStatus,
  outcome: string | null
): PlanStep[] {
  return plan.map((step) =>
    step.id === id ? { ...step, status, outcome } : step
  );
}

/**
 * Price and duplicate checks run once per metered service.
 *
 * Review found these hard-coded to Workers while the answer made invoice-wide
 * claims: a Workers AI reprice and a Workers AI duplicate were both missed
 * while the summary said pricing was unchanged and no duplicates existed. An
 * assertion about the invoice has to be backed by a check of the invoice.
 */
const PER_SERVICE_TOOLS = ["get_price_versions", "check_duplicate_usage"];

function expandPerServiceSteps(
  plan: PlanStep[],
  services: string[]
): PlanStep[] {
  const expanded: PlanStep[] = [];
  for (const step of plan) {
    if (!PER_SERVICE_TOOLS.includes(step.tool)) {
      expanded.push(step);
      continue;
    }
    for (const service of services) {
      expanded.push({
        ...step,
        id: stepId(step.tool, service),
        service,
        label: `${step.label} — ${service}`
      });
    }
  }
  return expanded;
}

/**
 * Metered services, taken from the decomposition, which sees every service on
 * the invoice. Fixed-fee lines have no usage to check and are excluded.
 */
export function meteredServices(record: InvestigationRecord): string[] {
  return [...record.serviceEffects]
    .filter((s) => s.metered)
    .map((s) => serviceName(s))
    .sort();
}

/**
 * The service to investigate in depth: the largest absolute mover, rather than
 * a compile-time constant. A hard-coded focus is right only by luck.
 */
export function pickFocusService(
  record: InvestigationRecord,
  metered: string[]
): string {
  const ranked = [...record.serviceEffects]
    .filter((s) => s.metered)
    .sort((a, b) => Math.abs(b.totalEffectCents) - Math.abs(a.totalEffectCents));
  return ranked[0] ? serviceName(ranked[0]) : (metered[0] ?? record.focusService);
}

function serviceName(effect: { serviceName: string }): string {
  return effect.serviceName;
}

/** Tool arguments are built by the server from the investigation record. */
function inputFor(
  tool: string,
  record: InvestigationRecord,
  service?: string
): Record<string, unknown> | null {
  const {
    accountId,
    currentPeriod,
    comparisonPeriod,
    focusService,
    facts
  } = record;
  if (!currentPeriod || !comparisonPeriod) return null;

  const from = periodStart(currentPeriod);
  const to = periodEnd(currentPeriod);

  switch (tool) {
    case "get_account_context":
      return { accountId };
    case "compare_invoices":
    case "decompose_variance":
      return { accountId, currentPeriod, comparisonPeriod };
    // Scoped to the driver: these locate when and where consumption moved.
    // The timeseries also carries the comparison window, because "which zone
    // generated the increase?" is a required follow-up and follow-ups answer
    // from persisted evidence — the comparison has to be on record by then.
    case "get_usage_timeseries":
      return {
        accountId,
        serviceName: focusService,
        startDate: from,
        endDate: to,
        comparisonStartDate: periodStart(comparisonPeriod),
        comparisonEndDate: periodEnd(comparisonPeriod)
      };
    case "detect_usage_change_point":
      return { accountId, serviceName: focusService, startDate: from, endDate: to };
    // Run per metered service, since the conclusion is invoice-wide.
    case "check_duplicate_usage":
      return {
        accountId,
        serviceName: service ?? focusService,
        startDate: from,
        endDate: to
      };
    case "get_price_versions":
      return {
        accountId,
        serviceName: service ?? focusService,
        startDate: periodStart(comparisonPeriod),
        endDate: to
      };
    case "get_account_events": {
      // Only meaningful once a change point exists to anchor the window.
      if (!facts.change_date) return null;
      const anchor = Date.parse(`${facts.change_date}T00:00:00Z`);
      return {
        accountId,
        startTimestamp: new Date(anchor - 86_400_000).toISOString(),
        endTimestamp: new Date(anchor + 86_400_000).toISOString()
      };
    }
    case "reconcile_invoice":
      return { accountId, period: currentPeriod };
    default:
      return null;
  }
}

function summarise(tool: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  switch (tool) {
    case "get_account_context":
      return `${d.displayName}`;
    case "compare_invoices":
      return `variance ${d.varianceCents} cents`;
    case "decompose_variance":
      return `${Number(d.explainedPercent).toFixed(2)}% explained`;
    case "get_usage_timeseries":
      return `${d.totalQuantity} units`;
    case "get_price_versions":
      return d.priceChanged ? "price changed" : "no price change";
    case "detect_usage_change_point":
      return d.changeDate ? `change on ${d.changeDate}` : "no change point";
    case "get_account_events":
      return `${(d.events as unknown[]).length} events in window`;
    case "check_duplicate_usage":
      return `${d.exactCount} exact, ${d.probableCount} probable`;
    case "reconcile_invoice":
      return `${d.status}`;
    default:
      return "completed";
  }
}

/**
 * Executes one allowlisted tool with the server-built input, folding the
 * result into the record. Returns the record unchanged if the budget is spent.
 */
async function callTool(
  record: InvestigationRecord,
  tool: string,
  deps: LoopDeps,
  service?: string
): Promise<InvestigationRecord> {
  const id = stepId(tool, service);

  if (record.metrics.toolCalls >= MAX_TOOL_CALLS_PER_TURN) {
    return {
      ...record,
      plan: setStep(record.plan, id, "skipped", "tool-call limit reached"),
      blockers: [...new Set([...record.blockers, "tool-call limit reached"])]
    };
  }

  const input = inputFor(tool, record, service);
  if (input === null) {
    return {
      ...record,
      plan: setStep(record.plan, id, "skipped", "prerequisite data missing")
    };
  }

  let result: ToolResult<unknown> = await deps.runner.run(tool, input);
  let attempts = 1;
  // One retry, and only for a failure the tool itself marked retryable.
  while (
    isFailure(result) &&
    result.error.retryable &&
    attempts <= MAX_TOOL_RETRIES
  ) {
    result = await deps.runner.run(tool, input);
    attempts++;
  }

  const execution = deps.runner.executions.at(-1);
  const cached = execution?.cached ?? false;
  const metrics = {
    ...record.metrics,
    toolCalls: record.metrics.toolCalls + attempts,
    cachedToolCalls: record.metrics.cachedToolCalls + (cached ? 1 : 0)
  };

  if (isFailure(result)) {
    return {
      ...record,
      metrics,
      plan: setStep(record.plan, id, "failed", result.error.code),
      blockers: [...new Set([...record.blockers, `${id}: ${result.error.code}`])]
    };
  }

  return {
    ...record,
    metrics,
    plan: setStep(record.plan, id, "completed", summarise(tool, result.data)),
    evidence: [...record.evidence, ...result.evidence],
    serviceEffects: captureServiceEffects(record.serviceEffects, tool, result.data),
    unverifiedFixedCharges: captureUnverifiedFixedCharges(
      record.unverifiedFixedCharges,
      tool,
      result.data
    ),
    facts: applyToolFacts(record.facts, tool, result.data, {
      changeDate: record.facts.change_date
    })
  };
}

/**
 * The decomposition is the only place that sees every service on the invoice,
 * so its per-service breakdown is kept rather than discarded. A metered service
 * is one with usage quantities; fixed-fee lines have none.
 */
/**
 * Fixed charges reconciliation could not authorise. R2 and D1 are illustrative
 * flat charges in this dataset with no subscription behind them, so arithmetic
 * consistency is all that can be said about them.
 */
function captureUnverifiedFixedCharges(
  current: string[],
  tool: string,
  data: unknown
): string[] {
  if (tool !== "reconcile_invoice") return current;
  const d = data as { unverifiedFixedCharges?: string[] };
  return Array.isArray(d.unverifiedFixedCharges)
    ? d.unverifiedFixedCharges
    : current;
}

function captureServiceEffects(
  current: ServiceEffectSummary[],
  tool: string,
  data: unknown
): ServiceEffectSummary[] {
  if (tool !== "decompose_variance") return current;
  const d = data as {
    services?: {
      serviceName: string;
      currentQuantity: number | null;
      totalEffectCents: number;
    }[];
  };
  if (!Array.isArray(d.services)) return current;

  return d.services.map((s) => ({
    serviceName: s.serviceName,
    metered: s.currentQuantity !== null,
    totalEffectCents: s.totalEffectCents
  }));
}

const DEFAULT_CLARIFICATION =
  "Which two billing periods should I compare for this account?";

/** Reads as one request: the reply alone does not say what was being asked. */
function clarificationContext(
  record: InvestigationRecord,
  reply: string
): string {
  return [
    `Original request: ${record.originalQuestion ?? ""}`.trim(),
    `Clarification asked: ${record.clarificationQuestion ?? DEFAULT_CLARIFICATION}`,
    `Answer: ${reply}`
  ].join("\n");
}

type PeriodChoice =
  | { currentPeriod: string; comparisonPeriod: string }
  | { clarify: string };

function listPeriods(periods: string[]): string {
  return [...periods].sort().join(", ");
}

/**
 * Which two periods to compare, or what to ask.
 *
 * A requested period that the account does not have is *reported*, never
 * quietly swapped for the newest invoice. Substituting turned "why did May
 * jump?" into an investigation of August and answered it with conviction — the
 * wrong question, answered correctly, is worse than no answer.
 *
 * Falling back to the two most recent invoices stays legitimate in exactly one
 * case: the model could not be reached at all, so nothing was requested and
 * nothing is being overridden.
 */
function resolvePeriods(
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

  // The reader named them, so there is nothing left to infer.
  //
  // Validating only that the model's periods exist was not enough: asked which
  // two to compare and answered "2026-06 and 2026-07", the live model replied
  // with 2026-07 and 2026-08 — both available, so nothing objected, and the
  // agent investigated a pair the reader had not asked for and reported it as
  // the answer. An explicit instruction is data, not a suggestion, and it does
  // not go through the model to be confirmed.
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
      currentPeriod: sorted.at(-1)!,
      comparisonPeriod: sorted.at(-2)!
    };
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

/**
 * Classify and pin down the periods, or return the record still waiting.
 *
 * `question` is what the model reads; `provenance` is the request to remember,
 * so a clarification round trip keeps the original rather than storing the
 * synthesised context as though the user had typed it.
 */
async function classifyPeriods(
  record: InvestigationRecord,
  question: string,
  provenance: string,
  userText: string,
  deps: LoopDeps
): Promise<InvestigationRecord> {
  const context = await deps.runner.run("get_account_context", {
    accountId: record.accountId
  });
  const periods = isFailure(context)
    ? []
    : (context.data as { availableInvoices: { period: string }[] })
        .availableInvoices.map((i) => i.period);

  // Checked against what the reader actually typed, before the model is asked.
  //
  // Validating only the model's answer is not enough: shown the available
  // periods, the live model quietly answers with those instead of the months
  // it was asked about, so the substitution happens before any check can see
  // it. Production proved this — "why did my May 2026 invoice jump compared to
  // April 2026?" returned a reconciled, high-confidence answer whose figures
  // were August's and whose prose said May.
  //
  // Only this turn's text is read. The synthesised clarification context still
  // quotes the original request, so parsing that would re-raise the same
  // objection forever and the reader could never answer it.
  const asked = periodsNamed(userText, periods);
  if (periods.length > 0) {
    const unavailable = asked.filter((p) => !periods.includes(p));
    if (unavailable.length > 0) {
      return {
        ...record,
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
      originalQuestion: remembered,
      state: transition(record.state, "clarification_required"),
      clarificationQuestion: choice.clarify
    };
  }

  return {
    ...record,
    caseType: "invoice_variance",
    originalQuestion: remembered,
    currentPeriod: choice.currentPeriod,
    comparisonPeriod: choice.comparisonPeriod,
    clarificationQuestion: null,
    state: transition(record.state, "planning")
  };
}

function applyHypotheses(
  record: InvestigationRecord,
  update: PlanUpdate
): InvestigationRecord {
  if (update.hypothesisUpdates.length === 0) return record;
  const byId = new Map(update.hypothesisUpdates.map((u) => [u.hypothesis, u.status]));
  return {
    ...record,
    hypotheses: record.hypotheses.map((h) =>
      byId.has(h.id) ? { ...h, status: byId.get(h.id)! } : h
    )
  };
}

/** Runs the invoice-variance playbook for one user turn. */
export async function runInvestigationTurn(
  input: InvestigationRecord,
  question: string,
  deps: LoopDeps
): Promise<InvestigationRecord> {
  // The state machine has no edge out of completed or unresolved, so resuming
  // a finished investigation would fail deep in the loop with a confusing
  // transition error. Say so plainly instead: a new question needs a new
  // investigation, and a question about a finished one is a follow-up.
  if (isTerminal(input.state)) {
    throw new Error(
      `investigation ${input.investigationId} is already ${input.state}; start a new one or ask a follow-up`
    );
  }

  let record = input;

  // 1. Classify. A clarification reply is classified too, against the request
  // it answers — the previous branch transitioned straight to planning without
  // reclassifying, so the periods stayed null and every turn after a
  // clarification investigated nothing and returned unresolved.
  if (record.state === "created") {
    record = await classifyPeriods(record, question, question, question, deps);
  } else if (record.state === "clarification_required") {
    record = await classifyPeriods(
      record,
      clarificationContext(record, question),
      record.originalQuestion ?? question,
      question,
      deps
    );
  }

  // Still unanswered: ask again rather than investigate an unknown period.
  if (record.state === "clarification_required") return record;

  record = { ...record, state: transition(record.state, "investigating") };

  // 2. Required prelude, in fixed order. The model cannot skip these.
  for (const step of REQUIRED_PRELUDE) {
    record = await callTool(record, step.tool, deps);
  }

  // 2a. Comparison and decomposition now tell us which services are metered and
  // which is the actual driver. Both were previously hard-coded to Workers,
  // which made Workers-only findings read as invoice-wide claims.
  const metered = meteredServices(record);
  if (metered.length > 0) {
    record = {
      ...record,
      focusService: pickFocusService(record, metered),
      plan: expandPerServiceSteps(record.plan, metered)
    };
  }

  // 3. Bounded planning cycles selecting conditional tools.
  for (let cycle = 0; cycle < MAX_PLANNING_CYCLES_PER_TURN; cycle++) {
    const completed = record.plan
      .filter((s) => s.status === "completed")
      .map((s) => s.tool);
    const remaining = CONDITIONAL_STEPS.filter(
      (s) => !completed.includes(s.tool)
    );
    if (remaining.length === 0) break;
    if (record.metrics.toolCalls >= MAX_TOOL_CALLS_PER_TURN) break;

    let update: PlanUpdate;
    try {
      const raw = await deps.model.planNext({
        question,
        facts: record.facts,
        hypotheses: record.hypotheses,
        completedTools: completed,
        availableTools: remaining.map((s) => ({ tool: s.tool, when: s.when })),
        remainingToolBudget: MAX_TOOL_CALLS_PER_TURN - record.metrics.toolCalls
      });
      // Unknown fields are ignored, unknown tool names dropped. PRD §10.7.
      update = planUpdateSchema.parse(raw);
    } catch {
      update = {
        nextTools: remaining.map((s) => s.tool),
        reason: "",
        hypothesisUpdates: [],
        done: false
      };
    }

    record = applyHypotheses(record, update);
    // `update.reason` is model reasoning and is deliberately not persisted.

    const selected = update.nextTools.filter(
      (tool) => isConditionalTool(tool) && !completed.includes(tool)
    );

    record = { ...record, metrics: { ...record.metrics, planningCycles: record.metrics.planningCycles + 1 } };

    if (selected.length === 0) break;
    for (const tool of selected) {
      if (PER_SERVICE_TOOLS.includes(tool) && metered.length > 0) {
        // One call per metered service, so an invoice-wide statement is backed
        // by a check of the whole invoice.
        for (const service of metered) {
          record = await callTool(record, tool, deps, service);
        }
      } else {
        record = await callTool(record, tool, deps);
      }
    }
    if (update.done) break;
  }

  // 3a. Backstop: run any diagnostic the variance makes applicable that the
  // model did not select. Live running showed the real model omitting the price
  // check, which correctly produced "unresolved" — but a mandatory check should
  // not depend on the model choosing it. The model owns ordering and optional
  // extras; it does not gate required work.
  // Recomputed as facts arrive: get_account_events only becomes applicable once
  // the change point has produced a date to anchor its window, so a single
  // up-front list would miss it.
  for (let pass = 0; pass < PER_SERVICE_TOOLS.length + 2; pass++) {
    const done = record.plan
      .filter((s) => s.status === "completed")
      .map((s) => s.id);
    const missing = applicableDiagnostics(record.facts, metered).filter(
      (id) => !done.includes(id)
    );
    if (missing.length === 0) break;
    if (record.metrics.toolCalls >= MAX_TOOL_CALLS_PER_TURN) break;

    for (const id of missing) {
      if (record.metrics.toolCalls >= MAX_TOOL_CALLS_PER_TURN) break;
      const [tool, service] = id.split(":");
      record = await callTool(record, tool, deps, service);
    }
  }

  // 4. Reconciliation is forced, never selected. PRD §10.5 rule 2.
  record = { ...record, state: transition(record.state, "reconciling") };
  record = await callTool(record, REQUIRED_RECONCILIATION.tool, deps);

  // 5. Server-side completion criteria and deterministic confidence.
  // Step ids, not tool names, so a per-service check counts only for the
  // service it actually covered.
  const completedTools = record.plan
    .filter((s) => s.status === "completed")
    .map((s) => s.id);
  const failedTools = record.plan
    .filter((s) => s.status === "failed")
    .map((s) => s.id);

  const assessment = assessCompletion({
    facts: record.facts,
    completedTools,
    meteredServices: metered,
    // Fixed charges with no authorising subscription can only be checked
    // arithmetically, so movement in one cannot be called explained.
    unverifiedFixedCharges: record.unverifiedFixedCharges,
    fixedFeeMovementByService: Object.fromEntries(
      record.serviceEffects
        .filter((s) => !s.metered)
        .map((s) => [s.serviceName, s.totalEffectCents])
    ),
    failedTools
  });

  record = {
    ...record,
    facts: { ...record.facts, confidence: assessment.confidence },
    blockers: [...new Set([...record.blockers, ...assessment.blockers])]
  };

  const fallback = deterministicSummary(
    record.facts,
    record.evidence,
    assessment,
    {
      currentPeriod: record.currentPeriod!,
      comparisonPeriod: record.comparisonPeriod!
    }
  );

  // 6. The model phrases the conclusion; it cannot change it.
  let summary = fallback;
  try {
    const prose = await deps.model.explain({
      question,
      facts: record.facts,
      evidence: record.evidence,
      hypotheses: record.hypotheses,
      invoiceAppearsCorrect: assessment.invoiceAppearsCorrect,
      blockers: assessment.blockers,
      mode: "summary"
    });
    // Prose is only shown when every figure and identifier in it already
    // appears in verified evidence. One fabricated number discredits the whole
    // sentence, so it is all-or-nothing.
    const narrative = safeNarrative(prose, fallback.finding, {
      facts: record.facts,
      evidence: record.evidence,
      invoiceAppearsCorrect: assessment.invoiceAppearsCorrect,
      confidence: assessment.confidence,
      periods: [record.currentPeriod!, record.comparisonPeriod!],
      rejectGeneratedSections: true
    });
    if (narrative.usedModel) {
      summary = { ...fallback, finding: narrative.text, generatedBy: "model" };
    }
  } catch {
    // Keep the deterministic summary. PRD §8.5, §19.
  }

  return {
    ...record,
    summary,
    state: transition(
      record.state,
      assessment.invoiceAppearsCorrect ? "completed" : "unresolved"
    ),
    metrics: { ...record.metrics, completedAt: new Date().toISOString() }
  };
}

/**
 * Billing periods a piece of user text names.
 *
 * The year is inferred from the account's own invoices where the text omits
 * one, because "August versus July" is how the question is actually asked. Only
 * years the account has invoices in are tried, so an omitted year can never
 * invent a period out of range.
 */
function periodsNamed(text: string, available: string[]): string[] {
  const years = [...new Set(available.map((p) => Number(p.slice(0, 4))))];
  const found = new Set<string>(periodsMentioned(text));
  for (const year of years) {
    for (const period of periodsMentioned(text, year)) found.add(period);
  }
  return [...found].sort();
}

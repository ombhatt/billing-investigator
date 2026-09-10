import { periodEnd, periodStart } from "../domain/period.js";
import { applyToolFacts, emptyFacts } from "../tools/facts.js";
import type { ToolRunner } from "../tools/registry.js";
import { isFailure, type ToolResult } from "../types/tools.js";
import { assessCompletion } from "./completion.js";
import type { ModelClient, PlanUpdate } from "./modelClient.js";
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
    state: "created",
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
    case "get_usage_timeseries":
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

  // 1. Classify, or reuse an existing classification.
  if (record.state === "created") {
    const context = await deps.runner.run("get_account_context", {
      accountId: record.accountId
    });
    const periods = isFailure(context)
      ? []
      : ((context.data as { availableInvoices: { period: string }[] })
          .availableInvoices.map((i) => i.period));

    let classification;
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
    const sorted = [...periods].sort();
    const currentPeriod =
      classification && periods.includes(classification.currentPeriod)
        ? classification.currentPeriod
        : (sorted.at(-1) ?? null);
    const comparisonPeriod =
      classification && periods.includes(classification.comparisonPeriod)
        ? classification.comparisonPeriod
        : (sorted.at(-2) ?? null);

    if (classification?.needsClarification) {
      return {
        ...record,
        state: transition(record.state, "clarification_required"),
        clarificationQuestion:
          classification.clarificationQuestion ??
          "Which billing periods should I compare?"
      };
    }

    if (!currentPeriod || !comparisonPeriod || currentPeriod === comparisonPeriod) {
      return {
        ...record,
        state: transition(record.state, "clarification_required"),
        clarificationQuestion:
          "Which two billing periods should I compare for this account?"
      };
    }

    record = {
      ...record,
      caseType: "invoice_variance",
      currentPeriod,
      comparisonPeriod,
      state: transition(record.state, "planning")
    };
  } else if (record.state === "clarification_required") {
    record = { ...record, state: transition(record.state, "planning") };
  }

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

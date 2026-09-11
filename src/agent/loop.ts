import { periodEnd, periodStart } from "../domain/period.js";
import {
  driverService,
  meteredServiceNames,
  type ServiceCandidate
} from "../domain/servicePolicy.js";
import { emptyFacts } from "../tools/facts.js";
import { isAllowedTool } from "../tools/registry.js";
import type { ToolInput, ToolName, ToolRunner } from "../tools/registry.js";

import { applicableDiagnostics, assessCompletion } from "./completion.js";
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
  REQUIRED_PRELUDE,
  REQUIRED_RECONCILIATION
} from "./playbooks/invoiceVariance.js";
import { classifyPeriods, clarificationContext } from "./periodResolution.js";
import { reduceSkipped, reduceToolResult } from "./resultReducer.js";
import { isTerminal, transition } from "./stateMachine.js";
import { ToolExecutor } from "./toolExecution.js";
import { deterministicSummary } from "./summary.js";
import type { InvestigationRecord, PlanStep } from "./types.js";

export interface LoopDeps {
  runner: ToolRunner;
  model: ModelClient;
  focusService: string;
}

/**
 * What the turn passes around internally. The caller supplies a runner; the
 * turn wraps it in the one executor that owns the budget for that turn.
 */
interface TurnDeps {
  executor: ToolExecutor;
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
export function stepId(tool: ToolName, service?: string): string {
  return service === undefined ? tool : `${tool}:${service}`;
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
  return meteredServiceNames(asCandidates(record));
}

/**
 * The record stores `metered` as a boolean; the shared policy reads a quantity.
 * One conversion here keeps the policy free of the record's shape.
 */
function asCandidates(record: InvestigationRecord): ServiceCandidate[] {
  return record.serviceEffects.map((s) => ({
    serviceName: s.serviceName,
    currentQuantity: s.metered ? 1 : null,
    totalEffectCents: s.totalEffectCents
  }));
}

/**
 * The service to investigate in depth: the largest absolute mover, rather than
 * a compile-time constant. A hard-coded focus is right only by luck.
 */
export function pickFocusService(
  record: InvestigationRecord,
  metered: string[]
): string {
  return driverService(asCandidates(record), metered[0] ?? record.focusService);
}

/**
 * Tool arguments, built by the server from the investigation record.
 *
 * One builder per tool, each returning that tool exact input type, so a
 * misspelled or mistyped argument fails the build rather than the request. A
 * builder returns null when the record cannot supply the arguments yet.
 */
type InputBuilder<N extends ToolName> = (
  record: InvestigationRecord,
  service: string | undefined
) => ToolInput<N> | null;

const INPUT_BUILDERS: { [N in ToolName]: InputBuilder<N> } = {
  get_account_context: (record) => ({ accountId: record.accountId }),

  compare_invoices: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        currentPeriod: p.current,
        comparisonPeriod: p.comparison
      }
    );
  },

  decompose_variance: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        currentPeriod: p.current,
        comparisonPeriod: p.comparison
      }
    );
  },

  // Scoped to the driver: this locates when and where consumption moved. It
  // also carries the comparison window, because "which zone generated the
  // increase?" is a required follow-up and follow-ups answer from persisted
  // evidence — the comparison has to be on record by then.
  get_usage_timeseries: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: record.focusService,
        startDate: periodStart(p.current),
        endDate: periodEnd(p.current),
        comparisonStartDate: periodStart(p.comparison),
        comparisonEndDate: periodEnd(p.comparison)
      }
    );
  },

  detect_usage_change_point: (record) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: record.focusService,
        startDate: periodStart(p.current),
        endDate: periodEnd(p.current)
      }
    );
  },

  // Run per metered service, since the conclusion is invoice-wide.
  check_duplicate_usage: (record, service) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: service ?? record.focusService,
        startDate: periodStart(p.current),
        endDate: periodEnd(p.current)
      }
    );
  },

  get_price_versions: (record, service) => {
    const p = periods(record);
    return (
      p && {
        accountId: record.accountId,
        serviceName: service ?? record.focusService,
        startDate: periodStart(p.comparison),
        endDate: periodEnd(p.current)
      }
    );
  },

  get_account_events: (record) => {
    // Only meaningful once a change point exists to anchor the window.
    if (!periods(record) || !record.facts.change_date) return null;
    const anchor = Date.parse(`${record.facts.change_date}T00:00:00Z`);
    return {
      accountId: record.accountId,
      startTimestamp: new Date(anchor - 86_400_000).toISOString(),
      endTimestamp: new Date(anchor + 86_400_000).toISOString()
    };
  },

  reconcile_invoice: (record) => {
    const p = periods(record);
    return p && { accountId: record.accountId, period: p.current };
  }
};

/**
 * Both periods, or null. Returning them rather than a boolean is what lets the
 * builders below drop their non-null assertions.
 */
function periods(
  record: InvestigationRecord
): { current: string; comparison: string } | null {
  return record.currentPeriod && record.comparisonPeriod
    ? { current: record.currentPeriod, comparison: record.comparisonPeriod }
    : null;
}

function inputFor<N extends ToolName>(
  tool: N,
  record: InvestigationRecord,
  service?: string
): ToolInput<N> | null {
  return (INPUT_BUILDERS[tool] as InputBuilder<N>)(record, service) || null;
}

/**
 * Runs one allowlisted tool and folds the result into the record.
 *
 * Sequencing only: the executor owns the budget and the retry, the reducer
 * owns what the result means. What is left here is choosing the step id and
 * the arguments.
 */
async function callTool<N extends ToolName>(
  record: InvestigationRecord,
  tool: N,
  deps: TurnDeps,
  service?: string
): Promise<InvestigationRecord> {
  const id = stepId(tool, service);

  const input = inputFor(tool, record, service);
  if (input === null) {
    return reduceSkipped(record, id, "prerequisite data missing");
  }

  const outcome = await deps.executor.execute(tool, input);
  if (outcome.result === null) {
    return reduceSkipped(record, id, "tool-call limit reached");
  }

  return reduceToolResult(record, id, tool, outcome.result, {
    toolCalls: deps.executor.toolCalls,
    cachedToolCalls: deps.executor.cachedToolCalls
  });
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

  // One executor per turn: every tool call, wherever it is made from, is
  // counted here. Classification used to call the runner directly and go
  // uncounted, so a twelve-call turn reported eleven.
  const turn: TurnDeps = {
    executor: new ToolExecutor(deps.runner, {
      alreadySpent: input.metrics.toolCalls,
      alreadyCached: input.metrics.cachedToolCalls
    }),
    model: deps.model,
    focusService: deps.focusService
  };

  let record = input;

  // 1. Classify. A clarification reply is classified too, against the request
  // it answers — the previous branch transitioned straight to planning without
  // reclassifying, so the periods stayed null and every turn after a
  // clarification investigated nothing and returned unresolved.
  if (record.state === "created") {
    record = await classifyPeriods(record, question, question, question, turn);
  } else if (record.state === "clarification_required") {
    record = await classifyPeriods(
      record,
      clarificationContext(record, question),
      record.originalQuestion ?? question,
      question,
      turn
    );
  }

  // Still unanswered: ask again rather than investigate an unknown period.
  if (record.state === "clarification_required") return record;

  record = { ...record, state: transition(record.state, "investigating") };

  // 2. Required prelude, in fixed order. The model cannot skip these.
  for (const step of REQUIRED_PRELUDE) {
    record = await callTool(record, step.tool, turn);
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

    // The narrowing boundary for model input: a name the model supplied is a
    // plain string until `isConditionalTool` vouches for it.
    const selected = update.nextTools.filter(
      (tool): tool is ToolName =>
        isConditionalTool(tool) && !completed.includes(tool)
    );

    record = { ...record, metrics: { ...record.metrics, planningCycles: record.metrics.planningCycles + 1 } };

    if (selected.length === 0) break;
    for (const tool of selected) {
      if (PER_SERVICE_TOOLS.includes(tool) && metered.length > 0) {
        // One call per metered service, so an invoice-wide statement is backed
        // by a check of the whole invoice.
        for (const service of metered) {
          record = await callTool(record, tool, turn, service);
        }
      } else {
        record = await callTool(record, tool, turn);
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
      // Ids are built from the allowlist, so this holds; the guard is what lets
      // the compiler know it, and what would catch a malformed id.
      if (!isAllowedTool(tool)) continue;
      record = await callTool(record, tool, turn, service);
    }
  }

  // 4. Reconciliation is forced, never selected. PRD §10.5 rule 2.
  record = { ...record, state: transition(record.state, "reconciling") };
  record = await callTool(record, REQUIRED_RECONCILIATION.tool, turn);

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

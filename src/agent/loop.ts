import {
  driverService,
  meteredServiceNames,
  type ServiceCandidate
} from "../domain/servicePolicy.js";
import { isAllowedTool } from "../tools/registry.js";
import type { ToolName, ToolRunner } from "../tools/registry.js";

import { applicableDiagnostics, assessCompletion } from "./completion.js";
import { emptyFacts } from "./facts.js";
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
import { inputFor } from "./toolInputs.js";
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
function stepId(tool: ToolName, service?: string): string {
  return service === undefined ? tool : `${tool}:${service}`;
}

/**
 * Price and duplicate checks run once per metered service: an invoice-wide
 * claim has to be backed by a check of the whole invoice. ARCHITECTURE.md §13.
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
function pickFocusService(
  record: InvestigationRecord,
  metered: string[]
): string {
  return driverService(asCandidates(record), metered[0] ?? record.focusService);
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

  // One executor per turn: every tool call, classification included, is
  // counted in one place. ARCHITECTURE.md §23.
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
  // it answers, so the periods it names take effect. See ARCHITECTURE.md §17.
  if (record.state === "created") {
    // Opening question: all three views of the turn are the same text.
    record = await classifyPeriods(
      record,
      {
        modelQuestion: question,
        originalQuestion: question,
        userReply: question
      },
      turn
    );
  } else if (record.state === "clarification_required") {
    record = await classifyPeriods(
      record,
      {
        modelQuestion: clarificationContext(record, question),
        originalQuestion: record.originalQuestion ?? question,
        userReply: question
      },
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

  // 2a. Comparison and decomposition are what reveal which services are metered
  // and which is the driver; neither is known before they run.
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
  // model did not select. The model owns ordering and optional extras; it never
  // gates required work. ARCHITECTURE.md §12.
  // Recomputed each pass rather than listed up front: get_account_events only
  // becomes applicable once the change point has produced a date to anchor it.
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
  const completedStepIds = record.plan
    .filter((s) => s.status === "completed")
    .map((s) => s.id);
  const failedTools = record.plan
    .filter((s) => s.status === "failed")
    .map((s) => s.id);

  const assessment = assessCompletion({
    facts: record.facts,
    completedStepIds,
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

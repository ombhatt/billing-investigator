import { applyToolFacts } from "./facts.js";
import type { ToolName, ToolOutput } from "../tools/registry.js";
import { isFailure, type ToolResult } from "../types/tools.js";
import type {
  InvestigationRecord,
  PlanStep,
  ServiceEffectSummary,
  StepStatus
} from "./types.js";

/**
 * Folding one tool result into the investigation record.
 *
 * Separate from the coordinator because it changes for different reasons: a new
 * fact, a new piece of per-service state, a different step outcome. The
 * coordinator decides *what to run and when*; this decides *what a result
 * means* for the record.
 */

export function setStep(
  plan: PlanStep[],
  id: string,
  status: StepStatus,
  outcome: string | null
): PlanStep[] {
  return plan.map((step) =>
    step.id === id ? { ...step, status, outcome } : step
  );
}

/** A one-line factual outcome per step. Never the model's reasoning. */
type Summariser<N extends ToolName> = (data: ToolOutput<N>) => string;

const SUMMARISERS: { [N in ToolName]: Summariser<N> } = {
  get_account_context: (d) => d.displayName,
  compare_invoices: (d) => `variance ${d.varianceCents} cents`,
  decompose_variance: (d) => `${d.explainedPercent.toFixed(2)}% explained`,
  get_usage_timeseries: (d) => `${d.totalQuantity} units`,
  get_price_versions: (d) => (d.priceChanged ? "price changed" : "no price change"),
  detect_usage_change_point: (d) =>
    d.changeDate ? `change on ${d.changeDate}` : "no change point",
  get_account_events: (d) => `${d.events.length} events in window`,
  check_duplicate_usage: (d) => `${d.exactCount} exact, ${d.probableCount} probable`,
  reconcile_invoice: (d) => d.status
};

export function summarise<N extends ToolName>(
  tool: N,
  data: ToolOutput<N>
): string {
  return (SUMMARISERS[tool] as Summariser<N>)(data);
}

/**
 * Fixed charges reconciliation could not authorise. R2 and D1 are illustrative
 * flat charges in this dataset with no subscription behind them, so arithmetic
 * consistency is all that can be said about them.
 */
function captureUnverifiedFixedCharges<N extends ToolName>(
  current: string[],
  tool: N,
  data: ToolOutput<N>
): string[] {
  if (tool !== "reconcile_invoice") return current;
  // Comparing `tool` does not narrow `N`, so the compiler cannot follow this
  // one step. The runtime check immediately above is what makes it sound.
  const report = data as ToolOutput<"reconcile_invoice">;
  return report.unverifiedFixedCharges ?? current;
}

/**
 * The decomposition is the only place that sees every service on the invoice,
 * so its per-service breakdown is kept rather than discarded. A metered service
 * is one with usage quantities; fixed-fee lines have none.
 */
function captureServiceEffects<N extends ToolName>(
  current: ServiceEffectSummary[],
  tool: N,
  data: ToolOutput<N>
): ServiceEffectSummary[] {
  if (tool !== "decompose_variance") return current;
  // As above: guarded by the check on the line before, not by an assumption.
  const d = data as ToolOutput<"decompose_variance">;

  return d.services.map((s) => ({
    serviceName: s.serviceName,
    metered: s.currentQuantity !== null,
    totalEffectCents: s.totalEffectCents
  }));
}

/** Metrics after an execution, whatever its outcome. */
export interface ExecutionMetrics {
  toolCalls: number;
  cachedToolCalls: number;
}

/**
 * The record after one tool ran. A failure records a blocker and leaves the
 * facts untouched — a tool that did not answer must not look like one that
 * answered "nothing".
 */
export function reduceToolResult<N extends ToolName>(
  record: InvestigationRecord,
  stepId: string,
  tool: N,
  result: ToolResult<ToolOutput<N>>,
  metrics: ExecutionMetrics
): InvestigationRecord {
  const withMetrics = {
    ...record,
    metrics: { ...record.metrics, ...metrics }
  };

  if (isFailure(result)) {
    return {
      ...withMetrics,
      plan: setStep(record.plan, stepId, "failed", result.error.code),
      blockers: [
        ...new Set([...record.blockers, `${stepId}: ${result.error.code}`])
      ]
    };
  }

  return {
    ...withMetrics,
    plan: setStep(record.plan, stepId, "completed", summarise(tool, result.data)),
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

/** The record when the budget ran out before a step could run. */
export function reduceSkipped(
  record: InvestigationRecord,
  stepId: string,
  reason: string
): InvestigationRecord {
  return {
    ...record,
    plan: setStep(record.plan, stepId, "skipped", reason),
    blockers:
      reason === "tool-call limit reached"
        ? [...new Set([...record.blockers, reason])]
        : record.blockers
  };
}

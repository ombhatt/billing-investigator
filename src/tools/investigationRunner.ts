import { evaluateConfidence } from "../domain/confidence.js";
import { periodEnd, periodStart } from "../domain/period.js";
import type { ToolDeps } from "./createTool.js";
import { ToolRunner } from "./registry.js";
import type { EvidenceCard, ToolResult } from "../types/tools.js";

export interface InvestigationRequest {
  accountId: string;
  currentPeriod: string;
  comparisonPeriod: string;
  focusService: string;
}

export interface InvestigationStep {
  order: number;
  tool: string;
  label: string;
  status: "completed" | "failed";
  summary: string;
}

/** Narrow a tool result, failing loudly rather than silently continuing. */
function expectOk<T>(result: ToolResult<unknown>, tool: string): T {
  if ("error" in result) {
    throw new Error(`${tool} failed: ${result.error.code} ${result.error.message}`);
  }
  return result.data as T;
}

/**
 * Executes the invoice-variance playbook end to end through the allowlisted
 * tools, reading D1, with no model involved.
 *
 * This is what proves the read path: the domain tests already show the maths is
 * right, but only running the same investigation through repositories and tools
 * catches a mis-mapped column or a query that quietly drops rows.
 */
export async function runInvestigation(
  deps: ToolDeps,
  request: InvestigationRequest
) {
  const { accountId, currentPeriod, comparisonPeriod, focusService } = request;
  const runner = new ToolRunner(deps);
  const steps: InvestigationStep[] = [];
  const evidence: EvidenceCard[] = [];

  const record = (
    order: number,
    tool: string,
    label: string,
    result: ToolResult<unknown>,
    summary: string
  ) => {
    const failed = "error" in result;
    steps.push({
      order,
      tool,
      label,
      status: failed ? "failed" : "completed",
      summary: failed ? `${result.error.code}: ${result.error.message}` : summary
    });
    if (!failed) evidence.push(...result.evidence);
  };

  // 1. Confirm the account and the invoices available.
  const contextResult = await runner.run("get_account_context", { accountId });
  const context = expectOk<{
    displayName: string;
    currency: string;
    availableInvoices: { period: string }[];
  }>(contextResult, "get_account_context");
  record(
    1,
    "get_account_context",
    "Confirming the account",
    contextResult,
    `${context.displayName}, ${context.availableInvoices.length} invoices available`
  );

  // 2. Compare the two invoices.
  const compareResult = await runner.run("compare_invoices", {
    accountId,
    currentPeriod,
    comparisonPeriod
  });
  const comparison = expectOk<{
    currentTotalCents: number;
    comparisonTotalCents: number;
    varianceCents: number;
    percentageVarianceDisplay: number | null;
    services: { serviceName: string; varianceCents: number }[];
    rankedDrivers: { serviceName: string; varianceCents: number }[];
  }>(compareResult, "compare_invoices");
  record(
    2,
    "compare_invoices",
    "Comparing invoices",
    compareResult,
    `variance ${comparison.varianceCents} cents (${comparison.percentageVarianceDisplay}%)`
  );

  // 3. Separate usage, price, fixed fee, credit and tax effects.
  const decomposeResult = await runner.run("decompose_variance", {
    accountId,
    currentPeriod,
    comparisonPeriod
  });
  const decomposition = expectOk<{
    volumeEffectCents: number;
    priceEffectCents: number;
    unexplainedCents: number;
    explainedPercent: number;
  }>(decomposeResult, "decompose_variance");
  record(
    3,
    "decompose_variance",
    "Separating usage, price, credit and tax effects",
    decomposeResult,
    `${decomposition.explainedPercent.toFixed(2)}% explained`
  );

  const from = periodStart(currentPeriod);
  const to = periodEnd(currentPeriod);

  // 4. Inspect the driver's daily series.
  const seriesResult = await runner.run("get_usage_timeseries", {
    accountId,
    serviceName: focusService,
    startDate: from,
    endDate: to
  });
  const series = expectOk<{
    totalQuantity: number;
    points: { date: string; quantity: number }[];
    zones: { zoneId: string; quantity: number }[];
  }>(seriesResult, "get_usage_timeseries");
  record(
    4,
    "get_usage_timeseries",
    `Inspecting ${focusService} usage`,
    seriesResult,
    `${series.totalQuantity} units across ${series.points.length} days`
  );

  // 5. Rule price in or out across both periods.
  const priceResult = await runner.run("get_price_versions", {
    accountId,
    serviceName: focusService,
    startDate: periodStart(comparisonPeriod),
    endDate: to
  });
  const pricing = expectOk<{ priceChanged: boolean; versions: { priceVersionId: string }[] }>(
    priceResult,
    "get_price_versions"
  );
  record(
    5,
    "get_price_versions",
    "Checking contract pricing",
    priceResult,
    pricing.priceChanged ? "price changed" : "no price change"
  );

  // 6. Locate the change point.
  const changeResult = await runner.run("detect_usage_change_point", {
    accountId,
    serviceName: focusService,
    startDate: from,
    endDate: to
  });
  const changePoint = expectOk<{
    detected: boolean;
    changeDate: string | null;
    ratio: number | null;
    material: boolean;
  }>(changeResult, "detect_usage_change_point");
  record(
    6,
    "detect_usage_change_point",
    "Locating the usage change",
    changeResult,
    changePoint.changeDate
      ? `${changePoint.changeDate}, ${changePoint.ratio?.toFixed(2)}x`
      : "no change point"
  );

  // 7. Correlate operational events, only if a change point was found.
  let correlatedEventId: string | null = null;
  if (changePoint.changeDate) {
    const anchor = Date.parse(`${changePoint.changeDate}T00:00:00Z`);
    const eventsResult = await runner.run("get_account_events", {
      accountId,
      startTimestamp: new Date(anchor - 86_400_000).toISOString(),
      endTimestamp: new Date(anchor + 86_400_000).toISOString()
    });
    const events = expectOk<{ events: { eventId: string; occurredAt: string }[] }>(
      eventsResult,
      "get_account_events"
    );
    // Nearest in time first. Correlation only. PRD §12.8.
    const ranked = [...events.events].sort(
      (a, b) =>
        Math.abs(Date.parse(a.occurredAt) - anchor) -
        Math.abs(Date.parse(b.occurredAt) - anchor)
    );
    correlatedEventId = ranked[0]?.eventId ?? null;
    record(
      7,
      "get_account_events",
      "Checking account events near the change",
      eventsResult,
      correlatedEventId
        ? `${events.events.length} events, nearest ${correlatedEventId}`
        : "no events in window"
    );
  }

  // 8. Rule duplicates in or out.
  const duplicateResult = await runner.run("check_duplicate_usage", {
    accountId,
    serviceName: focusService,
    startDate: from,
    endDate: to
  });
  const duplicates = expectOk<{
    exactCount: number;
    probableCount: number;
    eventsChecked: number;
  }>(duplicateResult, "check_duplicate_usage");
  record(
    8,
    "check_duplicate_usage",
    "Checking for duplicate usage",
    duplicateResult,
    `${duplicates.exactCount} exact, ${duplicates.probableCount} probable across ${duplicates.eventsChecked} events`
  );

  // 9. Reconcile raw usage through to the invoice total.
  const reconcileResult = await runner.run("reconcile_invoice", {
    accountId,
    period: currentPeriod
  });
  const reconciliation = expectOk<{
    status: "passed" | "failed";
    checkpoints: { passed: boolean }[];
  }>(reconcileResult, "reconcile_invoice");
  record(
    9,
    "reconcile_invoice",
    "Reconciling usage with the invoice",
    reconcileResult,
    `${reconciliation.status}, ${reconciliation.checkpoints.length} boundaries`
  );

  const confidence = evaluateConfidence({
    explainedPercent: decomposition.explainedPercent,
    reconciliationPassed: reconciliation.status === "passed",
    requiredChecksComplete: steps.every((s) => s.status === "completed"),
    materialConflict: duplicates.exactCount > 0 || duplicates.probableCount > 0
  });

  const serviceVariance = (name: string) =>
    comparison.services.find((s) => s.serviceName === name)?.varianceCents ?? 0;

  return {
    steps,
    evidence,
    executions: runner.executions,
    facts: {
      current_total_cents: comparison.currentTotalCents,
      comparison_total_cents: comparison.comparisonTotalCents,
      variance_cents: comparison.varianceCents,
      percentage_variance_display: comparison.percentageVarianceDisplay,
      workers_variance_cents: serviceVariance("Workers"),
      workers_ai_variance_cents: serviceVariance("Workers AI"),
      price_changed: pricing.priceChanged,
      change_date: changePoint.changeDate,
      correlated_event_id: correlatedEventId,
      exact_duplicate_count: duplicates.exactCount,
      probable_duplicate_count: duplicates.probableCount,
      reconciliation_status: reconciliation.status,
      explained_percent: decomposition.explainedPercent,
      volume_effect_cents: decomposition.volumeEffectCents,
      price_effect_cents: decomposition.priceEffectCents,
      confidence: confidence.confidence
    }
  };
}

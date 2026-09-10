import { correlateEvents, detectChangePoint, type DailyPoint } from "./changePoint.js";
import { compareInvoices } from "./compare.js";
import { evaluateConfidence } from "./confidence.js";
import { checkDuplicates } from "./duplicates.js";
import { periodEnd, periodStart } from "./period.js";
import { effectivePrice, priceChanged, priceVersionsOverlapping } from "./rating.js";
import { reconcileInvoice } from "./reconciliation.js";
import type { BillingDataset, Period } from "./types.js";
import { decomposeVariance } from "./variance.js";

export interface InvoiceVarianceInput {
  dataset: BillingDataset;
  currentPeriod: Period;
  comparisonPeriod: Period;
  /** Service whose time series drives change-point and duplicate analysis. */
  focusService: string;
}

/**
 * Runs the whole invoice-variance playbook with deterministic code only.
 * No model, no database, no network — this is the layer that has to be right
 * before any of it is exposed to an LLM.
 */
export function analyseInvoiceVariance(input: InvoiceVarianceInput) {
  const { dataset, currentPeriod, comparisonPeriod, focusService } = input;

  const currentInvoice = dataset.invoices.find((i) => i.period === currentPeriod);
  const comparisonInvoice = dataset.invoices.find(
    (i) => i.period === comparisonPeriod
  );
  if (!currentInvoice || !comparisonInvoice) {
    throw new Error(
      `missing invoice for ${currentPeriod} or ${comparisonPeriod}`
    );
  }

  const current = {
    invoice: currentInvoice,
    lines: dataset.invoiceLines.filter(
      (l) => l.invoiceId === currentInvoice.invoiceId
    )
  };
  const comparison = {
    invoice: comparisonInvoice,
    lines: dataset.invoiceLines.filter(
      (l) => l.invoiceId === comparisonInvoice.invoiceId
    )
  };

  const invoiceComparison = compareInvoices(current, comparison);

  const decomposition = decomposeVariance({
    currentPeriod,
    comparisonPeriod,
    daily: dataset.dailyUsage,
    prices: dataset.priceVersions,
    current,
    comparison
  });

  // Price check spans both periods so a mid-window change would be caught.
  const windowFrom = periodStart(comparisonPeriod);
  const windowTo = periodEnd(currentPeriod);
  const priceDidChange = priceChanged(
    dataset.priceVersions,
    focusService,
    windowFrom,
    windowTo
  );
  const priceVersions = priceVersionsOverlapping(
    dataset.priceVersions,
    focusService,
    windowFrom,
    windowTo
  );

  // Daily series for the focus service across the current period, all zones.
  const byDate = new Map<string, number>();
  for (const row of dataset.dailyUsage) {
    if (row.serviceName !== focusService) continue;
    if (!row.usageDate.startsWith(currentPeriod)) continue;
    byDate.set(row.usageDate, (byDate.get(row.usageDate) ?? 0) + row.quantity);
  }
  const series: DailyPoint[] = [...byDate.entries()]
    .map(([date, quantity]) => ({ date, quantity }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const focusPrice = effectivePrice(
    dataset.priceVersions,
    focusService,
    periodStart(currentPeriod),
    periodEnd(currentPeriod)
  );
  const changePoint = detectChangePoint(series, focusPrice);

  const correlated = changePoint.changeDate
    ? correlateEvents(dataset.accountEvents, changePoint.changeDate)
    : [];

  const duplicates = checkDuplicates(
    dataset.usageEvents.filter(
      (e) =>
        e.serviceName === focusService && e.occurredAt.startsWith(currentPeriod)
    ),
    focusPrice
  );

  const reconciliation = reconcileInvoice({
    accountId: dataset.account.accountId,
    period: currentPeriod,
    usageEvents: dataset.usageEvents,
    dailyUsage: dataset.dailyUsage,
    ratedCharges: dataset.ratedCharges,
    prices: dataset.priceVersions,
    invoice: currentInvoice,
    invoiceLines: current.lines
  });

  const confidence = evaluateConfidence({
    explainedPercent: decomposition.explainedPercent,
    reconciliationPassed: reconciliation.status === "passed",
    requiredChecksComplete: true,
    materialConflict:
      duplicates.exactCount > 0 || duplicates.probableCount > 0
  });

  return {
    invoiceComparison,
    decomposition,
    priceChanged: priceDidChange,
    priceVersions,
    series,
    changePoint,
    correlatedEvents: correlated,
    duplicates,
    reconciliation,
    confidence
  };
}

/** The structured fact block asserted by the golden test. PRD §20.4. */
export function goldenFacts(input: InvoiceVarianceInput) {
  const analysis = analyseInvoiceVariance(input);
  const service = (name: string) =>
    analysis.invoiceComparison.services.find((s) => s.serviceName === name);

  return {
    current_total_cents: analysis.invoiceComparison.currentTotalCents,
    comparison_total_cents: analysis.invoiceComparison.comparisonTotalCents,
    variance_cents: analysis.invoiceComparison.varianceCents,
    percentage_variance_display:
      analysis.invoiceComparison.percentageVarianceDisplay,
    workers_variance_cents: service("Workers")?.varianceCents ?? 0,
    workers_ai_variance_cents: service("Workers AI")?.varianceCents ?? 0,
    price_changed: analysis.priceChanged,
    change_date: analysis.changePoint.changeDate,
    correlated_event_id: analysis.correlatedEvents[0]?.event.eventId ?? null,
    exact_duplicate_count: analysis.duplicates.exactCount,
    probable_duplicate_count: analysis.duplicates.probableCount,
    reconciliation_status: analysis.reconciliation.status,
    explained_percent: analysis.decomposition.explainedPercent,
    // Carried because completion derives which diagnostics are applicable from
    // them: a non-zero volume effect is what makes the usage checks mandatory.
    volume_effect_cents: analysis.decomposition.volumeEffectCents,
    price_effect_cents: analysis.decomposition.priceEffectCents,
    confidence: analysis.confidence.confidence
  };
}

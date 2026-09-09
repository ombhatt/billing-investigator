/**
 * Development-only. Runs the golden invoice-variance calculations with the
 * domain modules alone — no LLM, no D1, no Worker runtime — and prints the
 * structured result as JSON.
 *
 *   npm run golden
 *   npm run golden -- --full
 */
import { formatUsd } from "../src/domain/money.js";
import {
  analyseInvoiceVariance,
  goldenFacts
} from "../src/domain/invoiceVarianceCase.js";
import { generateSyntheticData } from "../seed/generateSyntheticData.js";
import {
  COMPARISON_PERIOD,
  CURRENT_PERIOD,
  SERVICE_WORKERS
} from "../seed/constants.js";

const input = {
  dataset: generateSyntheticData(),
  currentPeriod: CURRENT_PERIOD,
  comparisonPeriod: COMPARISON_PERIOD,
  focusService: SERVICE_WORKERS
};

const facts = goldenFacts(input);

if (process.argv.includes("--full")) {
  const analysis = analyseInvoiceVariance(input);
  process.stdout.write(
    `${JSON.stringify(
      {
        facts,
        comparison: analysis.invoiceComparison,
        decomposition: analysis.decomposition,
        changePoint: analysis.changePoint,
        correlatedEvents: analysis.correlatedEvents.map((c) => ({
          eventId: c.event.eventId,
          eventType: c.event.eventType,
          name: c.event.name,
          occurredAt: c.event.occurredAt,
          hoursFromChange: c.hoursFromChange
        })),
        duplicates: {
          exactCount: analysis.duplicates.exactCount,
          probableCount: analysis.duplicates.probableCount,
          fingerprintsChecked: analysis.duplicates.fingerprintsChecked,
          method: analysis.duplicates.method
        },
        reconciliation: analysis.reconciliation,
        confidence: analysis.confidence
      },
      null,
      2
    )}\n`
  );
} else {
  process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
  process.stderr.write(
    `\n${formatUsd(facts.comparison_total_cents)} -> ` +
      `${formatUsd(facts.current_total_cents)} ` +
      `(${formatUsd(facts.variance_cents)}, ${facts.percentage_variance_display}%)\n` +
      "Run with --full for the complete analysis.\n"
  );
}

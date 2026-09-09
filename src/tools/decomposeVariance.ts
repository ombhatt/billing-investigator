import { z } from "zod";
import { formatUsd } from "../domain/money.js";
import { periodEnd, periodStart } from "../domain/period.js";
import { decomposeVariance as decompose } from "../domain/variance.js";
import { listPriceVersions } from "../repositories/pricingRepository.js";
import { listDailyUsageForPeriod } from "../repositories/usageRepository.js";
import { createTool, NotFound } from "./createTool.js";
import { loadInvoiceSide } from "./compareInvoices.js";
import { accountIdSchema, periodSchema } from "./validators.js";

export const TOOL_NAME = "decompose_variance";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  currentPeriod: periodSchema,
  comparisonPeriod: periodSchema
});

export const decomposeVariance = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, currentPeriod, comparisonPeriod }, deps) => {
    if (currentPeriod === comparisonPeriod) {
      throw new NotFound(
        "INVALID_PERIODS",
        "currentPeriod and comparisonPeriod must differ."
      );
    }

    const [current, comparison, currentDaily, comparisonDaily, prices] =
      await Promise.all([
        loadInvoiceSide(deps, accountId, currentPeriod),
        loadInvoiceSide(deps, accountId, comparisonPeriod),
        listDailyUsageForPeriod(deps.db, accountId, currentPeriod),
        listDailyUsageForPeriod(deps.db, accountId, comparisonPeriod),
        listPriceVersions(deps.db, accountId)
      ]);

    const result = decompose({
      currentPeriod,
      comparisonPeriod,
      daily: [...currentDaily, ...comparisonDaily],
      prices,
      current,
      comparison
    });

    const window = `${periodStart(comparisonPeriod)} to ${periodEnd(currentPeriod)}`;

    return {
      data: result,
      sourceRecordIds: [
        `invoices:${current.invoice.invoiceId}`,
        `invoices:${comparison.invoice.invoiceId}`,
        ...result.priceVersionIds.map((id) => `price_versions:${id}`)
      ],
      evidence: [
        {
          label: "Variance by cause",
          value:
            `volume ${formatUsd(result.volumeEffectCents)}, ` +
            `price ${formatUsd(result.priceEffectCents)}, ` +
            `fixed fee ${formatUsd(result.fixedFeeEffectCents)}, ` +
            `credit ${formatUsd(result.creditEffectCents)}, ` +
            `tax ${formatUsd(result.taxEffectCents)}`,
          source: TOOL_NAME,
          recordIds: result.priceVersionIds.map((id) => `price_versions:${id}`),
          period: window,
          status: "confirmed" as const
        },
        {
          label: "Variance explained",
          value: `${result.explainedPercent.toFixed(2)}% (${formatUsd(result.unexplainedCents)} unexplained)`,
          source: TOOL_NAME,
          recordIds: [`invoices:${current.invoice.invoiceId}`],
          period: window,
          status:
            result.unexplainedCents === 0
              ? ("confirmed" as const)
              : ("unresolved" as const)
        }
      ],
      dataLimitations:
        result.unexplainedCents === 0
          ? []
          : [
              `${formatUsd(result.unexplainedCents)} of the movement is not attributed to a known effect.`
            ]
    };
  }
);

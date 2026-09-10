import { z } from "zod";
import { formatUsd } from "../domain/money.js";
import { reconcileInvoice as reconcile } from "../domain/reconciliation.js";
import { listPriceVersions, listRatedCharges } from "../repositories/pricingRepository.js";
import { listSubscriptions } from "../repositories/subscriptionRepository.js";
import {
  listDailyUsageForPeriod,
  listUsageEventsForPeriod
} from "../repositories/usageRepository.js";
import { createTool } from "./createTool.js";
import { loadInvoiceSide } from "./compareInvoices.js";
import { accountIdSchema, periodSchema } from "./validators.js";

export const TOOL_NAME = "reconcile_invoice";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  period: periodSchema.describe("Billing period to reconcile, YYYY-MM")
});

export const reconcileInvoice = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, period }, deps) => {
    const [side, usageEvents, dailyUsage, ratedCharges, prices, subscriptions] =
      await Promise.all([
        loadInvoiceSide(deps, accountId, period),
        listUsageEventsForPeriod(deps.db, accountId, period),
        listDailyUsageForPeriod(deps.db, accountId, period),
        listRatedCharges(deps.db, accountId, period),
        listPriceVersions(deps.db, accountId),
        listSubscriptions(deps.db, accountId)
      ]);

    const report = reconcile({
      accountId,
      period,
      usageEvents,
      dailyUsage,
      ratedCharges,
      prices,
      invoice: side.invoice,
      invoiceLines: side.lines,
      subscriptions
    });

    const passed = report.status === "passed";

    return {
      data: report,
      sourceRecordIds: [
        `invoices:${side.invoice.invoiceId}`,
        ...ratedCharges.map((r) => `rated_charges:${r.ratedChargeId}`)
      ],
      evidence: [
        {
          label: "Invoice reconciliation",
          value: passed
            ? `All ${report.checkpoints.length} boundaries reconcile to zero`
            : `${report.checkpoints.filter((c) => !c.passed).length} of ${report.checkpoints.length} boundaries differ ` +
              `(${formatUsd(report.totalDiscrepancyCents)}, ${report.totalQuantityDiscrepancy} units)`,
          source: TOOL_NAME,
          recordIds: [`invoices:${side.invoice.invoiceId}`],
          period,
          status: passed ? ("confirmed" as const) : ("unresolved" as const)
        },
        ...report.checkpoints
          .filter((c) => !c.passed)
          .map((c) => ({
            label: `Boundary failed: ${c.boundary}`,
            value: `${c.scope}: expected ${c.expected}, actual ${c.actual}, difference ${c.difference}`,
            source: TOOL_NAME,
            recordIds: [`invoices:${side.invoice.invoiceId}`],
            period,
            status: "unresolved" as const
          }))
      ],
      dataLimitations: [
        // Recomputation, not a trust check on stored values. PRD §12.9.
        "Each stage is recomputed from its inputs; stored amounts are compared, not assumed correct.",
        "Reconciliation uses zero tolerance: any non-zero difference fails."
      ]
    };
  }
);

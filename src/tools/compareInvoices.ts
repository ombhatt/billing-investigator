import { z } from "zod";
import { compareInvoices as compare } from "../domain/compare.js";
import { formatUsd } from "../domain/money.js";
import {
  findInvoiceByPeriod,
  listInvoiceLines
} from "../repositories/invoiceRepository.js";
import { createTool, NotFound, type ToolDeps } from "./createTool.js";
import { accountIdSchema, periodSchema } from "./validators.js";

export const TOOL_NAME = "compare_invoices";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  currentPeriod: periodSchema.describe("Period under investigation, YYYY-MM"),
  comparisonPeriod: periodSchema.describe("Period to compare against, YYYY-MM")
});

/** Shared by compare_invoices, decompose_variance and reconcile_invoice. */
export async function loadInvoiceSide(
  deps: ToolDeps,
  accountId: string,
  period: string
) {
  const invoice = await findInvoiceByPeriod(deps.db, accountId, period);
  if (!invoice) {
    throw new NotFound(
      "INVOICE_NOT_FOUND",
      `No finalized invoice for ${accountId} in ${period}.`
    );
  }
  return {
    invoice,
    lines: await listInvoiceLines(deps.db, accountId, invoice.invoiceId)
  };
}

export const compareInvoices = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, currentPeriod, comparisonPeriod }, deps) => {
    if (currentPeriod === comparisonPeriod) {
      throw new NotFound(
        "INVALID_PERIODS",
        "currentPeriod and comparisonPeriod must differ."
      );
    }

    const [current, comparison] = await Promise.all([
      loadInvoiceSide(deps, accountId, currentPeriod),
      loadInvoiceSide(deps, accountId, comparisonPeriod)
    ]);

    const result = compare(current, comparison);

    return {
      data: result,
      sourceRecordIds: [
        `invoices:${result.currentInvoiceId}`,
        `invoices:${result.comparisonInvoiceId}`,
        ...[...current.lines, ...comparison.lines].map(
          (l) => `invoice_lines:${l.lineId}`
        )
      ],
      evidence: [
        {
          label: "Invoice total change",
          value:
            `${formatUsd(result.comparisonTotalCents)} to ${formatUsd(result.currentTotalCents)} ` +
            `(${formatUsd(result.varianceCents)}` +
            (result.percentageVarianceDisplay === null
              ? ", percentage not defined"
              : `, ${result.percentageVarianceDisplay}%`) +
            ")",
          source: TOOL_NAME,
          recordIds: [
            `invoices:${result.currentInvoiceId}`,
            `invoices:${result.comparisonInvoiceId}`
          ],
          period: `${comparisonPeriod} to ${currentPeriod}`,
          status: "confirmed" as const
        },
        ...result.rankedDrivers.map((driver) => ({
          label: `${driver.serviceName} movement`,
          value: `${formatUsd(driver.comparisonCents)} to ${formatUsd(driver.currentCents)} (${formatUsd(driver.varianceCents)})`,
          source: TOOL_NAME,
          recordIds: [`invoices:${result.currentInvoiceId}`],
          period: `${comparisonPeriod} to ${currentPeriod}`,
          status: "confirmed" as const
        }))
      ],
      dataLimitations:
        result.percentageVarianceDisplay === null
          ? ["Comparison total is zero, so percentage change is undefined."]
          : []
    };
  }
);

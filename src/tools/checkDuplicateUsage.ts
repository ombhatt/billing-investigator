import { z } from "zod";
import { checkDuplicates } from "../domain/duplicates.js";
import { formatUsd } from "../domain/money.js";
import { listPriceVersionsOverlapping } from "../repositories/pricingRepository.js";
import { listUsageEvents } from "../repositories/usageRepository.js";
import { createTool, NotFound } from "./createTool.js";
import {
  accountIdSchema,
  assertDateRange,
  dateRangeFields,
  serviceNameSchema
} from "./validators.js";

export const TOOL_NAME = "check_duplicate_usage";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  serviceName: serviceNameSchema,
  ...dateRangeFields
});

export const checkDuplicateUsage = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, serviceName, startDate, endDate }, deps) => {
    const range = assertDateRange(startDate, endDate);
    if (!range.ok) throw new NotFound("INVALID_DATE_RANGE", range.message);

    const events = await listUsageEvents(
      deps.db,
      accountId,
      serviceName,
      `${startDate}T00:00:00Z`,
      `${endDate}T23:59:59Z`
    );

    const prices = await listPriceVersionsOverlapping(
      deps.db,
      accountId,
      serviceName,
      startDate,
      endDate
    );
    const report = checkDuplicates(
      events,
      prices.length === 1 ? prices[0] : undefined
    );

    const clean = report.exactCount === 0 && report.probableCount === 0;
    const window = `${startDate} to ${endDate}`;

    return {
      data: {
        serviceName,
        startDate,
        endDate,
        eventsChecked: events.length,
        exactCount: report.exactCount,
        exactQuantity: report.exactQuantity,
        exactCostCents: report.exactCostCents,
        probableCount: report.probableCount,
        probableQuantity: report.probableQuantity,
        probableCostCents: report.probableCostCents,
        sampledRecordIds: report.sampledRecordIds,
        fingerprintsChecked: report.fingerprintsChecked,
        method: report.method
      },
      sourceRecordIds: report.sampledRecordIds.map((id) => `usage_events:${id}`),
      evidence: [
        {
          label: "Duplicate usage check",
          value: clean
            ? `No exact or probable duplicates across ${events.length.toLocaleString("en-US")} events`
            : `${report.exactCount} exact and ${report.probableCount} probable duplicate groups, ` +
              `estimated impact ${formatUsd(report.exactCostCents + report.probableCostCents)}`,
          source: TOOL_NAME,
          recordIds: report.sampledRecordIds.map((id) => `usage_events:${id}`),
          period: window,
          status: clean ? ("confirmed" as const) : ("unresolved" as const)
        }
      ],
      dataLimitations: [
        `Detection method: ${report.method}`,
        // Reported, never removed. PRD §12.6.
        "Suspected duplicates are reported only; no usage is excluded from billing.",
        ...(prices.length === 1
          ? []
          : ["Financial impact not estimated: no single price version covers the window."])
      ]
    };
  }
);

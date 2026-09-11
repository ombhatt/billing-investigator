import { z } from "zod";
import { detectChangePoint, type DailyPoint } from "../domain/changePoint.js";
import { formatUsd } from "../domain/money.js";
import { isoDate, quantity } from "../domain/units.js";
import { listPriceVersionsOverlapping } from "../repositories/pricingRepository.js";
import { listDailyUsage } from "../repositories/usageRepository.js";
import { createTool, NotFound } from "./createTool.js";
import {
  accountIdSchema,
  assertDateRange,
  dateRangeFields,
  serviceNameSchema,
  zoneIdSchema
} from "./validators.js";

export const TOOL_NAME = "detect_usage_change_point";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  serviceName: serviceNameSchema,
  ...dateRangeFields,
  zoneId: zoneIdSchema.optional()
});

export const detectUsageChangePoint = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, serviceName, startDate, endDate, zoneId }, deps) => {
    const range = assertDateRange(startDate, endDate);
    if (!range.ok) throw new NotFound("INVALID_DATE_RANGE", range.message);

    const rows = await listDailyUsage(
      deps.db,
      accountId,
      serviceName,
      startDate,
      endDate,
      zoneId
    );

    const byDate = new Map<string, number>();
    for (const row of rows) {
      byDate.set(row.usageDate, (byDate.get(row.usageDate) ?? 0) + row.quantity);
    }
    const series: DailyPoint[] = [...byDate.entries()]
      .map(([date, total]) => ({ date: isoDate(date), quantity: quantity(total) }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const prices = await listPriceVersionsOverlapping(
      deps.db,
      accountId,
      serviceName,
      startDate,
      endDate
    );
    const result = detectChangePoint(
      series,
      prices.length === 1 ? prices[0] : undefined
    );

    return {
      data: result,
      sourceRecordIds: rows.map(
        (r) => `daily_usage:${r.serviceName}:${r.zoneId}:${r.usageDate}`
      ),
      evidence: [
        {
          label: `${serviceName} usage change point`,
          value: result.detected
            ? `${result.changeDate}: daily volume moved from ` +
              `${Math.round(result.baselineDailyQuantity).toLocaleString("en-US")} to ` +
              `${Math.round(result.postChangeDailyQuantity).toLocaleString("en-US")} ` +
              `(${result.ratio?.toFixed(2)}x)`
            : (result.reason ?? "No change point detected"),
          source: TOOL_NAME,
          recordIds: result.changeDate
            ? [`daily_usage:${serviceName}:${result.changeDate}`]
            : [],
          period: `${startDate} to ${endDate}`,
          status: result.detected
            ? ("confirmed" as const)
            : ("not_found" as const)
        },
        ...(result.detected
          ? [
              {
                label: "Projected cost impact of the shift",
                value: `${formatUsd(result.projectedCostImpactCents)}${result.material ? " (material)" : " (not material)"}`,
                source: TOOL_NAME,
                recordIds: prices.map((p) => `price_versions:${p.priceVersionId}`),
                period: `${result.changeDate} to ${endDate}`,
                status: "confirmed" as const
              }
            ]
          : [])
      ],
      dataLimitations: [
        // A change point is a statistical observation about the series, and
        // saying so here keeps the model from upgrading it to a cause.
        "Change-point detection describes when usage moved, not why.",
        ...(prices.length === 1
          ? []
          : ["Cost impact not estimated: no single price version covers the window."])
      ]
    };
  }
);

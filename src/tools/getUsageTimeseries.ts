import { z } from "zod";
import { rateUsage } from "../domain/rating.js";
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

export const TOOL_NAME = "get_usage_timeseries";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  serviceName: serviceNameSchema.describe('Service name, e.g. "Workers"'),
  ...dateRangeFields,
  zoneId: zoneIdSchema.optional().describe("Restrict to a single zone")
});

export interface UsageTimeseries {
  serviceName: string;
  startDate: string;
  endDate: string;
  zoneId: string | null;
  unit: string | null;
  points: { date: string; quantity: number }[];
  totalQuantity: number;
  contractedCostCents: number | null;
  zones: { zoneId: string; quantity: number }[];
}

export const getUsageTimeseries = createTool<typeof inputSchema, UsageTimeseries>(
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

    if (rows.length === 0) {
      return {
        data: {
          serviceName,
          startDate,
          endDate,
          zoneId: zoneId ?? null,
          unit: null,
          points: [],
          totalQuantity: 0,
          contractedCostCents: null,
          zones: []
        },
        sourceRecordIds: [],
        evidence: [
          {
            label: `${serviceName} usage`,
            value: `No usage recorded between ${startDate} and ${endDate}`,
            source: TOOL_NAME,
            recordIds: [],
            period: `${startDate} to ${endDate}`,
            status: "not_found" as const
          }
        ],
        dataLimitations: [
          `No ${serviceName} daily usage exists for ${startDate}..${endDate}.`
        ]
      };
    }

    // Roll zones together per day; the per-zone split is returned separately.
    const byDate = new Map<string, number>();
    const byZone = new Map<string, number>();
    for (const row of rows) {
      byDate.set(row.usageDate, (byDate.get(row.usageDate) ?? 0) + row.quantity);
      byZone.set(row.zoneId, (byZone.get(row.zoneId) ?? 0) + row.quantity);
    }

    const points = [...byDate.entries()]
      .map(([date, quantity]) => ({ date, quantity }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const totalQuantity = points.reduce((sum, p) => sum + p.quantity, 0);

    const prices = await listPriceVersionsOverlapping(
      deps.db,
      accountId,
      serviceName,
      startDate,
      endDate
    );
    // Marginal cost only: monthly allowances apply to a whole period, so
    // applying them to an arbitrary window would misstate the figure.
    const contractedCostCents =
      prices.length === 1
        ? rateUsage(totalQuantity, {
            ...prices[0],
            includedQuantity: 0,
            fixedFeeCents: 0
          }).amountCents
        : null;

    return {
      data: {
        serviceName,
        startDate,
        endDate,
        zoneId: zoneId ?? null,
        unit: rows[0].unit,
        points,
        totalQuantity,
        contractedCostCents,
        zones: [...byZone.entries()]
          .map(([id, quantity]) => ({ zoneId: id, quantity }))
          .sort((a, b) => b.quantity - a.quantity)
      },
      sourceRecordIds: rows.map(
        (r) => `daily_usage:${r.serviceName}:${r.zoneId}:${r.usageDate}`
      ),
      evidence: [
        {
          label: `${serviceName} usage total`,
          value: `${totalQuantity.toLocaleString("en-US")} ${rows[0].unit} across ${points.length} days`,
          source: TOOL_NAME,
          recordIds: [`daily_usage:${serviceName}:${startDate}..${endDate}`],
          period: `${startDate} to ${endDate}`,
          status: "confirmed" as const
        }
      ],
      dataLimitations:
        contractedCostCents === null && prices.length !== 1
          ? [
              `${prices.length} price versions overlap this window, so a single contracted cost is not defined.`
            ]
          : []
    };
  }
);

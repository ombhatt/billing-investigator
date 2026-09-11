import { z } from "zod";
import { rateUsage } from "../domain/rating.js";
import { zoneGrowth, type ZoneGrowth } from "../domain/zoneGrowth.js";
import { cents, quantity, sumQuantities } from "../domain/units.js";
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
  zoneId: zoneIdSchema.optional().describe("Restrict to a single zone"),
  // Supplied by the server from the investigation record, never by the model.
  comparisonStartDate: dateRangeFields.startDate.optional(),
  comparisonEndDate: dateRangeFields.endDate.optional()
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
  /** Per-zone movement against the comparison period, when one was given. */
  zoneGrowth: ZoneGrowth[] | null;
}

export const getUsageTimeseries = createTool<typeof inputSchema, UsageTimeseries>(
  TOOL_NAME,
  inputSchema,
  async (
    {
      accountId,
      serviceName,
      startDate,
      endDate,
      zoneId,
      comparisonStartDate,
      comparisonEndDate
    },
    deps
  ) => {
    const range = assertDateRange(startDate, endDate);
    if (!range.ok) throw new NotFound("INVALID_DATE_RANGE", range.message);

    if (comparisonStartDate || comparisonEndDate) {
      if (!comparisonStartDate || !comparisonEndDate) {
        throw new NotFound(
          "INVALID_DATE_RANGE",
          "A comparison window needs both a start and an end date."
        );
      }
      const comparisonRange = assertDateRange(comparisonStartDate, comparisonEndDate);
      if (!comparisonRange.ok) {
        throw new NotFound("INVALID_DATE_RANGE", comparisonRange.message);
      }
    }

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
          zones: [],
          zoneGrowth: null
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
    const totalQuantity = sumQuantities(
      rows.map((r) => r.quantity),
      `${serviceName} usage total`
    );

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
            includedQuantity: quantity(0),
            fixedFeeCents: cents(0)
          }).amountCents
        : null;

    // A second read inside the same call, not a second tool call: the growth
    // question is required (PRD §7.4) and follow-ups answer from persisted
    // evidence, so the comparison has to exist by the time the plan finishes.
    const currentZones = [...byZone.entries()].map(([id, quantity]) => ({
      zoneId: id,
      quantity
    }));

    let growth: ZoneGrowth[] | null = null;
    if (comparisonStartDate && comparisonEndDate) {
      const comparisonRows = await listDailyUsage(
        deps.db,
        accountId,
        serviceName,
        comparisonStartDate,
        comparisonEndDate,
        zoneId
      );
      growth = zoneGrowth(
        currentZones,
        comparisonRows.map((r) => ({ zoneId: r.zoneId, quantity: r.quantity }))
      );
    }

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
        zones: [...currentZones].sort((a, b) => b.quantity - a.quantity),
        zoneGrowth: growth
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
        },
        {
          label: `${serviceName} usage by zone`,
          value: [...byZone.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(
              ([id, quantity]) =>
                `${id}: ${quantity.toLocaleString("en-US")} ${rows[0].unit} (${Math.round((quantity / totalQuantity) * 100)}%)`
            )
            .join("; "),
          source: TOOL_NAME,
          recordIds: [...byZone.keys()].map((id) => `zones:${id}`),
          period: `${startDate} to ${endDate}`,
          status: "confirmed" as const
        },
        // "Which zone generated the increase?" is a required follow-up
        // (PRD §7.4) and the card above cannot answer it: a share of the
        // period is not a share of the change. Both are kept, worded so they
        // cannot be mistaken for one another.
        ...(growth
          ? [
              {
                label: `${serviceName} growth by zone`,
                value: growth
                  .map(
                    (z) =>
                      `${z.zoneId}: ${z.comparisonQuantity.toLocaleString("en-US")} to ` +
                      `${z.currentQuantity.toLocaleString("en-US")} ${rows[0].unit} ` +
                      `(${z.deltaQuantity >= 0 ? "+" : ""}${z.deltaQuantity.toLocaleString("en-US")}` +
                      (z.shareOfGrowthPercent === null
                        ? ")"
                        : `, ${z.shareOfGrowthPercent.toFixed(1)}% of the increase)`)
                  )
                  .join("; "),
                source: TOOL_NAME,
                recordIds: growth.map((z) => `zones:${z.zoneId}`),
                period: `${comparisonStartDate} to ${endDate}`,
                status: "confirmed" as const
              }
            ]
          : [])
      ],
      dataLimitations: [
        ...(contractedCostCents === null && prices.length !== 1
          ? [
              `${prices.length} price versions overlap this window, so a single contracted cost is not defined.`
            ]
          : []),
        ...(growth
          ? []
          : [
              "Zone growth was not computed: no comparison period was supplied, so this shows the period's distribution only, not which zone drove any change."
            ])
      ]
    };
  }
);

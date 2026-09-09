import { z } from "zod";
import { formatUsd } from "../domain/money.js";
import { listPriceVersionsOverlapping } from "../repositories/pricingRepository.js";
import { createTool, NotFound } from "./createTool.js";
import {
  accountIdSchema,
  assertDateRange,
  dateRangeFields,
  serviceNameSchema
} from "./validators.js";

export const TOOL_NAME = "get_price_versions";

export const inputSchema = z.object({
  accountId: accountIdSchema,
  serviceName: serviceNameSchema,
  ...dateRangeFields
});

export const getPriceVersions = createTool(
  TOOL_NAME,
  inputSchema,
  async ({ accountId, serviceName, startDate, endDate }, deps) => {
    const range = assertDateRange(startDate, endDate);
    if (!range.ok) throw new NotFound("INVALID_DATE_RANGE", range.message);

    const versions = await listPriceVersionsOverlapping(
      deps.db,
      accountId,
      serviceName,
      startDate,
      endDate
    );

    // More than one version in force across the window means the rate moved.
    const priceChanged = versions.length > 1;
    const window = `${startDate} to ${endDate}`;

    return {
      data: {
        serviceName,
        startDate,
        endDate,
        priceChanged,
        versions: versions.map((v) => ({
          priceVersionId: v.priceVersionId,
          includedQuantity: v.includedQuantity,
          overageRateCents: v.overageRateCents,
          unitDivisor: v.unitDivisor,
          unit: v.unit,
          fixedFeeCents: v.fixedFeeCents,
          effectiveFrom: v.effectiveFrom,
          effectiveTo: v.effectiveTo
        }))
      },
      sourceRecordIds: versions.map((v) => `price_versions:${v.priceVersionId}`),
      evidence: [
        {
          label: `${serviceName} price change`,
          value: priceChanged
            ? `${versions.length} price versions in force across the window`
            : "No price change found",
          source: TOOL_NAME,
          recordIds: versions.map((v) => `price_versions:${v.priceVersionId}`),
          period: window,
          status:
            versions.length === 0
              ? ("not_found" as const)
              : ("confirmed" as const)
        },
        ...versions.map((v) => ({
          label: `${serviceName} rate`,
          value:
            `${formatUsd(v.overageRateCents)} per ${v.unitDivisor.toLocaleString("en-US")} ${v.unit}, ` +
            `${v.includedQuantity.toLocaleString("en-US")} included; effective ${v.effectiveFrom}` +
            (v.effectiveTo ? ` to ${v.effectiveTo}` : " onward"),
          source: TOOL_NAME,
          recordIds: [`price_versions:${v.priceVersionId}`],
          period: v.effectiveFrom,
          status: "confirmed" as const
        }))
      ],
      dataLimitations:
        versions.length === 0
          ? [`No price version covers ${serviceName} between ${startDate} and ${endDate}.`]
          : []
    };
  }
);

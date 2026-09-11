import { billingPeriod, isoDate } from "../domain/units.js";
import { z } from "zod";

/** Opaque short slugs. Anything else is rejected before reaching a repository. */
export const accountIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "accountId must be 1-64 chars [A-Za-z0-9_-]");

export const zoneIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "zoneId must be 1-64 chars [A-Za-z0-9_-]");

export const serviceNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9 ._-]{1,64}$/,
    "serviceName must be 1-64 chars [A-Za-z0-9 ._-]"
  );

/**
 * Zod checks the shape; the domain constructor checks the invariant and brands
 * the result. Doing both means a tool argument that reaches the domain has been
 * validated by the layer that owns each concern, and a tool cannot hand the
 * domain a period-shaped string it never looked at.
 */
export const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "period must be YYYY-MM")
  .transform((value) => billingPeriod(value));

/** Rejects both malformed strings and impossible dates such as 2026-02-30. */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "date must be a real calendar date")
  .transform((value) => isoDate(value));

export const isoTimestampSchema = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "timestamp must be ISO-8601"
  );

/** A year is generous for a monthly investigation and bounds the result size. */
export const MAX_RANGE_DAYS = 366;

export function assertDateRange(
  from: string,
  to: string
): { ok: true } | { ok: false; message: string } {
  if (from > to) {
    return { ok: false, message: `startDate ${from} is after endDate ${to}` };
  }
  const days =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1;
  if (days > MAX_RANGE_DAYS) {
    return {
      ok: false,
      message: `range of ${days} days exceeds the ${MAX_RANGE_DAYS}-day maximum`
    };
  }
  return { ok: true };
}

export const dateRangeFields = {
  startDate: isoDateSchema.describe("Inclusive start date, YYYY-MM-DD"),
  endDate: isoDateSchema.describe("Inclusive end date, YYYY-MM-DD")
};

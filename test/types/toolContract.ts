import type { ToolInput, ToolName, ToolOutput } from "../../src/tools/catalog.js";

/**
 * Type-level assertions about the tool catalog, enforced by `npm run typecheck`.
 *
 * The guarantee under test is a compile-time one, so asserting it at runtime
 * would prove nothing: a test that reads a field successfully says nothing
 * about whether the compiler would have objected to reading a field that does
 * not exist. Every `@ts-expect-error` below is an assertion that a particular
 * mistake *cannot compile* — and if a change ever makes one of them legal,
 * TypeScript reports the unused directive and the build fails.
 *
 * This file is never imported at runtime and emits nothing.
 */

// --- Arguments are checked -------------------------------------------------

export const validInput: ToolInput<"get_price_versions"> = {
  accountId: "abc123",
  serviceName: "Workers",
  startDate: "2026-07-01",
  endDate: "2026-08-31"
};

export const optionalArgOmitted: ToolInput<"get_usage_timeseries"> = {
  accountId: "abc123",
  serviceName: "Workers",
  startDate: "2026-08-01",
  endDate: "2026-08-31"
  // zoneId and the comparison window are genuinely optional
};

// @ts-expect-error a required argument may not be omitted
export const missingRequired: ToolInput<"get_price_versions"> = {
  accountId: "abc123",
  serviceName: "Workers"
};

export const unknownArgument: ToolInput<"reconcile_invoice"> = {
  accountId: "abc123",
  period: "2026-08",
  // @ts-expect-error a tool may not be handed an argument it does not accept
  sneakyExtraArgument: true
};

export const wrongArgumentType: ToolInput<"reconcile_invoice"> = {
  accountId: "abc123",
  // @ts-expect-error an argument may not be the wrong type
  period: 202608
};

// --- Results are checked ---------------------------------------------------

export const realField: number = null as unknown as ToolOutput<"compare_invoices">["varianceCents"];

export const realNullableField: string | null =
  null as unknown as ToolOutput<"detect_usage_change_point">["changeDate"];

// @ts-expect-error a result field that does not exist may not be read
export type MissingField = ToolOutput<"compare_invoices">["fieldThatDoesNotExist"];

// @ts-expect-error a result field may not be assumed to be a different type
export const wrongResultType: string =
  null as unknown as ToolOutput<"compare_invoices">["varianceCents"];

// --- Only allowlisted names exist -----------------------------------------

export const knownName: ToolName = "reconcile_invoice";

// @ts-expect-error a name absent from the allowlist is not a ToolName
export const unknownName: ToolName = "drop_tables";

// @ts-expect-error and neither is an inherited property name
export const prototypePollution: ToolName = "constructor";

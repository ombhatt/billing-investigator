import type { z } from "zod";
import type { ToolDeps, ToolHandler } from "./createTool.js";

import { checkDuplicateUsage, inputSchema as checkDuplicateUsageInput } from "./checkDuplicateUsage.js";
import { compareInvoices, inputSchema as compareInvoicesInput } from "./compareInvoices.js";
import { decomposeVariance, inputSchema as decomposeVarianceInput } from "./decomposeVariance.js";
import { detectUsageChangePoint, inputSchema as detectUsageChangePointInput } from "./detectUsageChangePoint.js";
import { getAccountContext, inputSchema as getAccountContextInput } from "./getAccountContext.js";
import { getAccountEvents, inputSchema as getAccountEventsInput } from "./getAccountEvents.js";
import { getPriceVersions, inputSchema as getPriceVersionsInput } from "./getPriceVersions.js";
import { getUsageTimeseries, inputSchema as getUsageTimeseriesInput } from "./getUsageTimeseries.js";
import { reconcileInvoice, inputSchema as reconcileInvoiceInput } from "./reconcileInvoice.js";

/**
 * The allowlist, with every tool's types intact.
 *
 * The registry used to store these as `ToolHandler<unknown>`, which meant nine
 * `as` casts on the way in and a matching cast at every consumer on the way
 * out. A tool could change the shape of its result and nothing downstream would
 * fail to compile — the facts reducer, the step summariser and the loop would
 * each keep asserting a shape that no longer existed.
 *
 * Declared without a type annotation on purpose: an annotation here would widen
 * the entries back to the erased form, which is precisely the bug. The
 * `satisfies` below enforces the shape while leaving each entry's exact types
 * inferred.
 */
export const TOOL_CATALOG = {
  get_account_context: { schema: getAccountContextInput, handler: getAccountContext },
  compare_invoices: { schema: compareInvoicesInput, handler: compareInvoices },
  decompose_variance: { schema: decomposeVarianceInput, handler: decomposeVariance },
  get_usage_timeseries: { schema: getUsageTimeseriesInput, handler: getUsageTimeseries },
  get_price_versions: { schema: getPriceVersionsInput, handler: getPriceVersions },
  detect_usage_change_point: {
    schema: detectUsageChangePointInput,
    handler: detectUsageChangePoint
  },
  get_account_events: { schema: getAccountEventsInput, handler: getAccountEvents },
  check_duplicate_usage: { schema: checkDuplicateUsageInput, handler: checkDuplicateUsage },
  reconcile_invoice: { schema: reconcileInvoiceInput, handler: reconcileInvoice }
} satisfies Record<
  string,
  {
    schema: z.ZodType<{ accountId: string }>;
    // Deliberately unconstrained in its output: pinning it here would erase the
    // very types this catalog exists to preserve.
    handler: (raw: unknown, deps: ToolDeps) => Promise<unknown>;
  }
>;

/** Every tool that may execute. Nothing outside this union can be called. */
export type ToolName = keyof typeof TOOL_CATALOG;

/** The validated argument object a tool accepts. */
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOL_CATALOG)[N]["schema"]>;

type OutputOf<H> = H extends ToolHandler<infer T> ? T : never;

/** The `data` a tool returns on success, exactly as the tool declares it. */
export type ToolOutput<N extends ToolName> = OutputOf<(typeof TOOL_CATALOG)[N]["handler"]>;

export const ALLOWED_TOOLS = Object.keys(TOOL_CATALOG).sort() as ToolName[];

/**
 * The runtime boundary. Tool names chosen by the model arrive as strings, and
 * this is the single place a string becomes a `ToolName` — so an unknown name
 * is rejected at runtime while everything past this point is checked by the
 * compiler.
 */
export function isAllowedTool(name: string): name is ToolName {
  return Object.hasOwn(TOOL_CATALOG, name);
}

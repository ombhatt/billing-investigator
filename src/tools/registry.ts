import type { ToolDeps, ToolHandler } from "./createTool.js";
import type { ToolResult } from "../types/tools.js";
import { getAccountContext, TOOL_NAME as GET_ACCOUNT_CONTEXT } from "./getAccountContext.js";
import { compareInvoices, TOOL_NAME as COMPARE_INVOICES } from "./compareInvoices.js";
import { decomposeVariance, TOOL_NAME as DECOMPOSE_VARIANCE } from "./decomposeVariance.js";
import { getUsageTimeseries, TOOL_NAME as GET_USAGE_TIMESERIES } from "./getUsageTimeseries.js";
import { getPriceVersions, TOOL_NAME as GET_PRICE_VERSIONS } from "./getPriceVersions.js";
import {
  detectUsageChangePoint,
  TOOL_NAME as DETECT_USAGE_CHANGE_POINT
} from "./detectUsageChangePoint.js";
import { getAccountEvents, TOOL_NAME as GET_ACCOUNT_EVENTS } from "./getAccountEvents.js";
import {
  checkDuplicateUsage,
  TOOL_NAME as CHECK_DUPLICATE_USAGE
} from "./checkDuplicateUsage.js";
import { reconcileInvoice, TOOL_NAME as RECONCILE_INVOICE } from "./reconcileInvoice.js";

/**
 * The allowlist. Single source of truth for what may execute. A name absent
 * from this map cannot be called, whatever asks for it. PRD §10.2, §17.
 */
export const TOOL_HANDLERS: Record<string, ToolHandler<unknown>> = {
  [GET_ACCOUNT_CONTEXT]: getAccountContext as ToolHandler<unknown>,
  [COMPARE_INVOICES]: compareInvoices as ToolHandler<unknown>,
  [DECOMPOSE_VARIANCE]: decomposeVariance as ToolHandler<unknown>,
  [GET_USAGE_TIMESERIES]: getUsageTimeseries as ToolHandler<unknown>,
  [GET_PRICE_VERSIONS]: getPriceVersions as ToolHandler<unknown>,
  [DETECT_USAGE_CHANGE_POINT]: detectUsageChangePoint as ToolHandler<unknown>,
  [GET_ACCOUNT_EVENTS]: getAccountEvents as ToolHandler<unknown>,
  [CHECK_DUPLICATE_USAGE]: checkDuplicateUsage as ToolHandler<unknown>,
  [RECONCILE_INVOICE]: reconcileInvoice as ToolHandler<unknown>
};

export const ALLOWED_TOOLS = Object.keys(TOOL_HANDLERS).sort();

export function isAllowedTool(name: string): boolean {
  return Object.hasOwn(TOOL_HANDLERS, name);
}

/** Key-sorted so argument order cannot produce two keys for one call. */
function cacheKey(name: string, input: unknown): string {
  const normalise = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalise);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalise(v)])
      );
    }
    return value;
  };
  return `${name}:${JSON.stringify(normalise(input))}`;
}

export interface ToolExecution {
  tool: string;
  input: unknown;
  result: ToolResult<unknown>;
  cached: boolean;
  durationMs: number;
}

/**
 * Executes allowlisted tools and remembers results within one investigation,
 * so an identical repeat call does not hit D1 again. PRD §5 (FR-5), §19.
 *
 * The cache lives in memory for the life of the runner. M4 persists it in the
 * agent's Durable Object so it survives across turns.
 */
export class ToolRunner {
  private readonly cache = new Map<string, ToolResult<unknown>>();
  readonly executions: ToolExecution[] = [];

  constructor(private readonly deps: ToolDeps) {}

  async run(name: string, input: unknown): Promise<ToolResult<unknown>> {
    const started = Date.now();

    if (!isAllowedTool(name)) {
      const result = {
        tool: name,
        executedAt: new Date().toISOString(),
        error: {
          code: "UNKNOWN_TOOL",
          message: `No tool named ${name} is available.`,
          retryable: false
        }
      };
      this.executions.push({
        tool: name,
        input,
        result,
        cached: false,
        durationMs: 0
      });
      return result;
    }

    const key = cacheKey(name, input);
    const hit = this.cache.get(key);
    if (hit) {
      this.executions.push({
        tool: name,
        input,
        result: hit,
        cached: true,
        durationMs: 0
      });
      return hit;
    }

    const result = await TOOL_HANDLERS[name](input, this.deps);
    // Only successful results are reused; a transient failure should be
    // retryable rather than sticky.
    if (!("error" in result)) this.cache.set(key, result);

    this.executions.push({
      tool: name,
      input,
      result,
      cached: false,
      durationMs: Date.now() - started
    });
    return result;
  }
}

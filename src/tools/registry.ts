import type { ToolDeps, ToolHandler } from "./createTool.js";
import type { ToolResult } from "../types/tools.js";
import {
  ALLOWED_TOOLS,
  isAllowedTool,
  TOOL_CATALOG,
  type ToolInput,
  type ToolName,
  type ToolOutput
} from "./catalog.js";

export { ALLOWED_TOOLS, isAllowedTool, TOOL_CATALOG };
export type { ToolInput, ToolName, ToolOutput };

/**
 * The nine handlers, keyed by name. Kept as a derived view of the catalog so
 * there is still one allowlist, not two. PRD §10.2, §17.
 */
export const TOOL_HANDLERS = Object.fromEntries(
  Object.entries(TOOL_CATALOG).map(([name, entry]) => [name, entry.handler])
) as { [N in ToolName]: (typeof TOOL_CATALOG)[N]["handler"] };

/**
 * The erased view, for code that must treat all nine tools identically — the
 * cross-cutting contract tests that assert every tool validates its input,
 * scopes its account and shapes its envelope the same way.
 *
 * This is the one sanctioned place the types are dropped, and it is deliberate:
 * a test that iterates the allowlist cannot know which tool it is holding. Any
 * consumer that *does* know should use `run`, where the compiler can help.
 */
export function erasedHandler(name: ToolName): ToolHandler<unknown> {
  return TOOL_CATALOG[name].handler as ToolHandler<unknown>;
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
  /** Identifies an exact repeat of this call, for the persisted cache. */
  cacheKey: string;
  result: ToolResult<unknown>;
  cached: boolean;
  durationMs: number;
}

/**
 * Somewhere a result can be kept between turns.
 *
 * Narrower than the full store on purpose: the runner needs to look a result up
 * and nothing else, so that is all it is given.
 */
export interface ResultCache {
  reusable(
    investigationId: string,
    cacheKey: string
  ): Promise<ToolResult<unknown> | null>;
}

/**
 * Executes allowlisted tools and remembers results within one investigation,
 * so an identical repeat call does not hit D1 again. PRD §5 (FR-5), §19.
 *
 * `run` is typed per tool: calling it with a known name checks the arguments
 * and types the result, so a tool that changes its shape breaks its consumers
 * at compile time rather than at a cast. The `string` overload remains for the
 * one case that genuinely has an unknown name — a tool the model asked for —
 * and that path still fails safely at runtime with `UNKNOWN_TOOL`.
 */
export class ToolRunner {
  private readonly cache = new Map<string, ToolResult<unknown>>();
  readonly executions: ToolExecution[] = [];

  constructor(
    private readonly deps: ToolDeps,
    /**
     * Results recorded by earlier turns. Without one the cache is per-turn,
     * which is what FR-5's "cached persisted result within the investigation"
     * was not getting.
     */
    private readonly persisted?: { store: ResultCache; investigationId: string }
  ) {}

  async run<N extends ToolName>(
    name: N,
    input: ToolInput<N>
  ): Promise<ToolResult<ToolOutput<N>>>;
  async run(name: string, input: unknown): Promise<ToolResult<unknown>>;
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
        cacheKey: cacheKey(name, input),
        result,
        cached: false,
        durationMs: 0
      });
      return result;
    }

    const key = cacheKey(name, input);
    const hit =
      this.cache.get(key) ??
      (await this.persisted?.store.reusable(this.persisted.investigationId, key));
    if (hit) {
      // Recorded again so the audit trail shows the call was made, and marked
      // cached so it is not charged against the budget.
      this.cache.set(key, hit);
      this.executions.push({
        tool: name,
        input,
        cacheKey: key,
        result: hit,
        cached: true,
        durationMs: 0
      });
      return hit;
    }

    const result = await TOOL_CATALOG[name].handler(input, this.deps);
    // Only successful results are reused; a transient failure should be
    // retryable rather than sticky.
    if (!("error" in result)) this.cache.set(key, result);

    this.executions.push({
      tool: name,
      input,
      cacheKey: key,
      result,
      cached: false,
      durationMs: Date.now() - started
    });
    return result;
  }
}

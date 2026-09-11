import { isFailure, type ToolResult } from "../types/tools.js";
import type {
  ToolInput,
  ToolName,
  ToolOutput,
  ToolRunner
} from "../tools/registry.js";
import {
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_RETRIES
} from "./playbooks/invoiceVariance.js";

/**
 * Every tool call in a turn, and the only place the budget is counted.
 *
 * Accounting used to live in two places: `callTool` incremented the metrics,
 * while period classification called the runner directly and was never counted
 * at all. A golden turn executed twelve tools and reported eleven, so the
 * "max 12 tool calls per turn" bound could be exceeded by exactly the call
 * nobody was watching. A limit enforced on one path is not a limit.
 *
 * Cache hits are recorded but do not consume budget. The bound exists to cap
 * work against D1 and time spent in a turn, and a cache hit is neither; making
 * a repeat of an already-answered question eat the allowance would punish the
 * cache for doing its job. They are still counted separately so the saving is
 * visible.
 */

export interface ExecutionOutcome<N extends ToolName> {
  /** Null when the budget was spent before this call could run. */
  result: ToolResult<ToolOutput<N>> | null;
  attempts: number;
  cached: boolean;
}

export interface ExecutorOptions {
  /**
   * Calls already spent, carried from the record. The budget travels with the
   * investigation rather than resetting, so a turn resumed after a
   * clarification cannot buy itself a fresh allowance.
   */
  alreadySpent?: number;
  alreadyCached?: number;
  maxCalls?: number;
  maxRetries?: number;
}

export class ToolExecutor {
  private calls: number;
  private cacheHits: number;
  private readonly maxCalls: number;
  private readonly maxRetries: number;

  constructor(
    private readonly runner: ToolRunner,
    options: ExecutorOptions = {}
  ) {
    this.calls = options.alreadySpent ?? 0;
    this.cacheHits = options.alreadyCached ?? 0;
    this.maxCalls = options.maxCalls ?? MAX_TOOL_CALLS_PER_TURN;
    this.maxRetries = options.maxRetries ?? MAX_TOOL_RETRIES;
  }

  /** Tool calls that did real work. PRD §10.6. */
  get toolCalls(): number {
    return this.calls;
  }

  get cachedToolCalls(): number {
    return this.cacheHits;
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.calls);
  }

  get exhausted(): boolean {
    return this.calls >= this.maxCalls;
  }

  /**
   * Runs one tool, retrying only a failure the tool itself marked retryable,
   * and only while the budget allows it.
   */
  async execute<N extends ToolName>(
    tool: N,
    input: ToolInput<N>
  ): Promise<ExecutionOutcome<N>> {
    if (this.exhausted) return { result: null, attempts: 0, cached: false };

    let result = await this.runner.run(tool, input);
    let cached = this.lastWasCached();
    let attempts = cached ? 0 : 1;

    while (
      isFailure(result) &&
      result.error.retryable &&
      attempts <= this.maxRetries &&
      this.calls + attempts < this.maxCalls
    ) {
      result = await this.runner.run(tool, input);
      cached = this.lastWasCached();
      if (!cached) attempts++;
    }

    this.calls += attempts;
    if (cached) this.cacheHits++;

    return { result, attempts, cached };
  }

  private lastWasCached(): boolean {
    return this.runner.executions.at(-1)?.cached ?? false;
  }
}

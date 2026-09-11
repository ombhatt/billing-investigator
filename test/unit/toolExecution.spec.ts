import { describe, expect, it } from "vitest";
import { ToolExecutor } from "../../src/agent/toolExecution.js";
import type { ToolRunner } from "../../src/tools/registry.js";

/**
 * Budget and retry, tested without a database or a playbook.
 *
 * These rules used to be spread across the coordinator: `callTool` incremented
 * the metrics and retried, while period classification called the runner
 * directly and was counted nowhere. A golden turn executed twelve tools and
 * reported eleven, so the twelve-call bound could be exceeded by exactly the
 * call nobody was watching. Concentrating it here is what makes it testable at
 * this level at all.
 */

/** A runner stand-in that records calls and replays scripted results. */
function stubRunner(script: unknown[] = []) {
  const executions: { tool: string; cached: boolean }[] = [];
  let index = 0;
  const runner = {
    executions,
    async run(tool: string) {
      const scripted = script[index++] ?? {
        tool,
        executedAt: "2026-09-10T00:00:00Z",
        data: {},
        evidence: [],
        sourceRecordIds: [],
        dataLimitations: []
      };
      const cached = (scripted as { __cached?: boolean }).__cached === true;
      executions.push({ tool, cached });
      return scripted;
    }
  };
  return { runner: runner as unknown as ToolRunner, executions };
}

const ok = { tool: "t", executedAt: "2026-09-10T00:00:00Z", data: {}, evidence: [], sourceRecordIds: [], dataLimitations: [] };
const retryable = {
  tool: "t",
  executedAt: "2026-09-10T00:00:00Z",
  error: { code: "D1_UNAVAILABLE", message: "temporary", retryable: true }
};
const permanent = {
  tool: "t",
  executedAt: "2026-09-10T00:00:00Z",
  error: { code: "INVOICE_NOT_FOUND", message: "no such invoice", retryable: false }
};

const anyInput = { accountId: "abc123" } as never;

describe("budget accounting", () => {
  it("counts every call, wherever it was made from", async () => {
    const { runner } = stubRunner();
    const executor = new ToolExecutor(runner, { maxCalls: 5 });

    await executor.execute("get_account_context", anyInput);
    await executor.execute("compare_invoices", anyInput);

    expect(executor.toolCalls).toBe(2);
    expect(executor.remaining).toBe(3);
  });

  it("carries a spend already made, so a resumed turn cannot buy a fresh allowance", async () => {
    const { runner } = stubRunner();
    const executor = new ToolExecutor(runner, { maxCalls: 12, alreadySpent: 11 });

    expect(executor.remaining).toBe(1);
    await executor.execute("compare_invoices", anyInput);
    expect(executor.exhausted).toBe(true);
  });

  it("refuses to run once the budget is spent, and says so by returning null", async () => {
    const { runner, executions } = stubRunner();
    const executor = new ToolExecutor(runner, { maxCalls: 1 });

    const first = await executor.execute("compare_invoices", anyInput);
    const second = await executor.execute("decompose_variance", anyInput);

    expect(first.result).not.toBeNull();
    expect(second.result).toBeNull();
    // The refusal is real: the second call never reached the runner.
    expect(executions).toHaveLength(1);
  });

  it("does not charge a cache hit against the budget", async () => {
    // The bound caps work against D1 and time in a turn. A cache hit is
    // neither, and charging it would punish the cache for doing its job.
    const { runner } = stubRunner([{ ...ok, __cached: true }]);
    const executor = new ToolExecutor(runner, { maxCalls: 3 });

    const outcome = await executor.execute("get_account_context", anyInput);

    expect(outcome.cached).toBe(true);
    expect(executor.toolCalls).toBe(0);
    expect(executor.cachedToolCalls).toBe(1);
  });
});

describe("retries", () => {
  it("retries a failure the tool marked retryable, once", async () => {
    const { runner, executions } = stubRunner([retryable, ok]);
    const executor = new ToolExecutor(runner, { maxCalls: 12 });

    const outcome = await executor.execute("compare_invoices", anyInput);

    expect(executions).toHaveLength(2);
    expect(outcome.attempts).toBe(2);
    expect(outcome.result).not.toBeNull();
    expect(outcome.result && "error" in outcome.result).toBe(false);
    // Both attempts are charged: both did work.
    expect(executor.toolCalls).toBe(2);
  });

  it("does not retry a failure the tool marked permanent", async () => {
    const { runner, executions } = stubRunner([permanent, ok]);
    const executor = new ToolExecutor(runner, { maxCalls: 12 });

    const outcome = await executor.execute("compare_invoices", anyInput);

    expect(executions).toHaveLength(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.result && "error" in outcome.result).toBe(true);
  });

  it("retries at most once, even when the failure keeps repeating", async () => {
    const { runner, executions } = stubRunner([retryable, retryable, retryable, ok]);
    const executor = new ToolExecutor(runner, { maxCalls: 12 });

    await executor.execute("compare_invoices", anyInput);

    expect(executions).toHaveLength(2);
  });

  it("will not retry past the budget", async () => {
    // A retry is a tool call. The limit is the limit.
    const { runner, executions } = stubRunner([retryable, ok]);
    const executor = new ToolExecutor(runner, { maxCalls: 1 });

    const outcome = await executor.execute("compare_invoices", anyInput);

    expect(executions).toHaveLength(1);
    expect(outcome.result && "error" in outcome.result).toBe(true);
    expect(executor.toolCalls).toBe(1);
  });
});

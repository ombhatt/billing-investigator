import type { ToolResult } from "../types/tools.js";
import type { ToolExecution } from "../tools/registry.js";
import type { InvestigationRecord } from "./types.js";
import { mayCommit } from "./generation.js";

/**
 * Where an investigation's evidence and state live.
 *
 * Two PRD requirements were only half met. FR-12 asks for "tool calls **and
 * results**" to be persisted; the agent wrote an audit row per call carrying the
 * tool name, timing and error code, and dropped the envelope — the evidence
 * cards, the data limitations, the values behind every claim. FR-5 asks for "a
 * cached **persisted** result within the investigation"; the cache was a `Map`
 * that died with the turn, so the same question asked twice re-read D1 both
 * times, and an isolate that went away took the evidence with it.
 *
 * Putting both behind one interface also removes the reason tests had to reach
 * into the Durable Object's own storage and state to observe them.
 */

/** A tool call and everything it produced, kept whole. */
export interface RecordedEnvelope {
  investigationId: string;
  tool: string;
  /** Identifies an exact repeat of the same call. */
  cacheKey: string;
  input: unknown;
  result: ToolResult<unknown>;
  cached: boolean;
  durationMs: number;
  executedAt: string;
}

export interface InvestigationStore {
  /** Records every execution of a turn, envelope included. */
  record(investigationId: string, executions: ToolExecution[]): Promise<void>;

  /**
   * A successful result already recorded for this exact call, or null.
   * Failures are never reused: a transient error should be retryable rather
   * than sticky.
   */
  reusable(
    investigationId: string,
    cacheKey: string
  ): Promise<ToolResult<unknown> | null>;

  /** Everything recorded for an investigation, oldest first. */
  envelopes(investigationId: string): Promise<RecordedEnvelope[]>;

  /** The conversation's current generation. Advanced by a reset. */
  generation(): Promise<number>;

  /**
   * Commits the record, but only into the generation the turn opened in.
   *
   * Returns false when a reset moved the generation on while the turn was
   * running. The check and the write must not be separated by an `await`, which
   * is why they live together here rather than at the call site.
   */
  commit(record: InvestigationRecord, openedIn: number): Promise<boolean>;
}

/**
 * Durable Object storage. `this.sql` is the object's own SQLite, not D1 — no
 * billing data is written anywhere by this.
 */
export interface DurableObjectHost {
  sql: <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => T[];
  readGeneration: () => number;
  setState: (record: InvestigationRecord | null, generation: number) => void;
}

export class DurableObjectStore implements InvestigationStore {
  private created = false;

  constructor(private readonly host: DurableObjectHost) {}

  private ensureTable(): void {
    if (this.created) return;
    // A new table rather than columns added to the old `tool_executions`:
    // Durable Objects already deployed carry the old schema, and
    // `CREATE TABLE IF NOT EXISTS` would leave them without the new columns.
    // `void` because the tagged template returns rows a write has no use for.
    void this.host.sql`
      CREATE TABLE IF NOT EXISTS tool_envelopes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        investigation_id TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        tool TEXT NOT NULL,
        input TEXT NOT NULL,
        envelope TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error_code TEXT,
        cached INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        executed_at TEXT NOT NULL
      )`;
    this.created = true;
  }

  async record(
    investigationId: string,
    executions: ToolExecution[]
  ): Promise<void> {
    this.ensureTable();
    for (const execution of executions) {
      const failed = "error" in execution.result;
      void this.host.sql`
        INSERT INTO tool_envelopes
          (investigation_id, cache_key, tool, input, envelope,
           ok, error_code, cached, duration_ms, executed_at)
        VALUES (
          ${investigationId},
          ${execution.cacheKey},
          ${execution.tool},
          ${JSON.stringify(execution.input)},
          ${JSON.stringify(execution.result)},
          ${failed ? 0 : 1},
          ${failed ? (execution.result as { error: { code: string } }).error.code : null},
          ${execution.cached ? 1 : 0},
          ${execution.durationMs},
          ${execution.result.executedAt}
        )`;
    }
  }

  async reusable(
    investigationId: string,
    cacheKey: string
  ): Promise<ToolResult<unknown> | null> {
    this.ensureTable();
    const rows = this.host.sql<{ envelope: string }>`
      SELECT envelope FROM tool_envelopes
       WHERE investigation_id = ${investigationId}
         AND cache_key = ${cacheKey}
         AND ok = 1
       ORDER BY id
       LIMIT 1`;
    return rows.length === 0
      ? null
      : (JSON.parse(rows[0].envelope) as ToolResult<unknown>);
  }

  async envelopes(investigationId: string): Promise<RecordedEnvelope[]> {
    this.ensureTable();
    const rows = this.host.sql<{
      investigation_id: string;
      cache_key: string;
      tool: string;
      input: string;
      envelope: string;
      cached: number;
      duration_ms: number;
      executed_at: string;
    }>`
      SELECT investigation_id, cache_key, tool, input, envelope,
             cached, duration_ms, executed_at
        FROM tool_envelopes
       WHERE investigation_id = ${investigationId}
       ORDER BY id`;

    return rows.map((row) => ({
      investigationId: row.investigation_id,
      cacheKey: row.cache_key,
      tool: row.tool,
      input: JSON.parse(row.input) as unknown,
      result: JSON.parse(row.envelope) as ToolResult<unknown>,
      cached: row.cached === 1,
      durationMs: row.duration_ms,
      executedAt: row.executed_at
    }));
  }

  async generation(): Promise<number> {
    return this.host.readGeneration();
  }

  async commit(record: InvestigationRecord, openedIn: number): Promise<boolean> {
    // Read and write with nothing awaited between them, so a reset cannot land
    // in the gap.
    if (!mayCommit(openedIn, this.host.readGeneration())) return false;
    this.host.setState(record, openedIn);
    return true;
  }
}

/**
 * The same contract, in memory.
 *
 * Tests used to reach into the Durable Object — shadowing `sql` and `setState`
 * on the SDK's own prototype — to watch persistence happen. They can use this
 * instead, and what they exercise is the interface production uses rather than
 * a stand-in for a stand-in.
 */
export class InMemoryInvestigationStore implements InvestigationStore {
  private readonly rows: RecordedEnvelope[] = [];
  private committed: InvestigationRecord | null = null;
  private current = 0;

  constructor(initialGeneration = 0) {
    this.current = initialGeneration;
  }

  /** Test-facing: what state a client would see. */
  get state(): { investigation: InvestigationRecord | null; generation: number } {
    return { investigation: this.committed, generation: this.current };
  }

  /** Test-facing: the reset a client asks for. */
  reset(): void {
    this.committed = null;
    this.current += 1;
  }

  async record(
    investigationId: string,
    executions: ToolExecution[]
  ): Promise<void> {
    for (const execution of executions) {
      this.rows.push({
        investigationId,
        cacheKey: execution.cacheKey,
        tool: execution.tool,
        input: execution.input,
        result: execution.result,
        cached: execution.cached,
        durationMs: execution.durationMs,
        executedAt: execution.result.executedAt
      });
    }
  }

  async reusable(
    investigationId: string,
    cacheKey: string
  ): Promise<ToolResult<unknown> | null> {
    const hit = this.rows.find(
      (r) =>
        r.investigationId === investigationId &&
        r.cacheKey === cacheKey &&
        !("error" in r.result)
    );
    return hit ? hit.result : null;
  }

  async envelopes(investigationId: string): Promise<RecordedEnvelope[]> {
    return this.rows.filter((r) => r.investigationId === investigationId);
  }

  async generation(): Promise<number> {
    return this.current;
  }

  async commit(record: InvestigationRecord, openedIn: number): Promise<boolean> {
    if (!mayCommit(openedIn, this.current)) return false;
    this.committed = record;
    return true;
  }
}

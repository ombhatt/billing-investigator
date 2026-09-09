import type { z } from "zod";
import { fail, ok } from "./envelope.js";
import type { EvidenceCard, ToolResult } from "../types/tools.js";

export interface ToolDeps {
  db: D1Database;
  /** Tools may only read this account. PRD §17, CLAUDE.md rule 5. */
  investigationAccountId: string;
}

export interface ToolBody<T> {
  data: T;
  sourceRecordIds?: string[];
  evidence?: EvidenceCard[];
  dataLimitations?: string[];
}

export type ToolHandler<T> = (
  raw: unknown,
  deps: ToolDeps
) => Promise<ToolResult<T>>;

/**
 * Wraps a tool so validation, account scoping and error safety cannot be
 * forgotten in one of nine near-identical implementations. The body only runs
 * once the input has parsed and the account has been checked.
 *
 * `NotFound` lets a handler report a missing record without throwing, keeping
 * "no such invoice" distinct from "the database is unreachable".
 */
export class NotFound extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function createTool<S extends z.ZodType<{ accountId: string }>, T>(
  name: string,
  schema: S,
  body: (input: z.infer<S>, deps: ToolDeps) => Promise<ToolBody<T>>
): ToolHandler<T> {
  return async (raw, deps) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".");
      return fail(
        name,
        "INVALID_INPUT",
        path ? `${path}: ${issue.message}` : (issue?.message ?? "Invalid input.")
      );
    }

    if (parsed.data.accountId !== deps.investigationAccountId) {
      return fail(
        name,
        "ACCOUNT_SCOPE_VIOLATION",
        `This investigation is scoped to account ${deps.investigationAccountId}.`
      );
    }

    try {
      const result = await body(parsed.data, deps);
      return ok(name, result.data, {
        sourceRecordIds: result.sourceRecordIds,
        evidence: result.evidence,
        dataLimitations: result.dataLimitations
      });
    } catch (error) {
      if (error instanceof NotFound) {
        return fail(name, error.code, error.message);
      }
      // Never surface a raw D1 error or a stack trace. PRD §16, §17.
      return fail(
        name,
        "DATA_SOURCE_UNAVAILABLE",
        "The billing data could not be read.",
        true
      );
    }
  };
}

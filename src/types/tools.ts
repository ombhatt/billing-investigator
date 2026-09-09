/** Evidence status vocabulary. PRD §8.3. */
export type EvidenceStatus =
  | "confirmed"
  | "correlated"
  | "not_found"
  | "unresolved";

/** A source-backed fact rendered as a card in the Evidence tab. PRD §8.3. */
export interface EvidenceCard {
  label: string;
  value: string;
  /** Tool that produced this card. */
  source: string;
  recordIds: string[];
  /** Billing period or ISO-8601 timestamp; null when not period-scoped. */
  period: string | null;
  status: EvidenceStatus;
}

/** Envelope every successful tool result carries. PRD §11. */
export interface ToolEnvelope<T> {
  tool: string;
  executedAt: string;
  sourceRecordIds: string[];
  evidence: EvidenceCard[];
  dataLimitations: string[];
  data: T;
}

/**
 * Safe tool failure. Carries a stable machine code and a message fit for the
 * browser — never a stack trace or raw database error. PRD §16, §17.
 */
export interface ToolFailure {
  tool: string;
  executedAt: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type ToolResult<T> = ToolEnvelope<T> | ToolFailure;

export function isFailure<T>(result: ToolResult<T>): result is ToolFailure {
  return "error" in result;
}

import type {
  EvidenceCard,
  ToolEnvelope,
  ToolFailure
} from "../types/tools.js";

export function ok<T>(
  tool: string,
  data: T,
  parts: {
    sourceRecordIds?: string[];
    evidence?: EvidenceCard[];
    dataLimitations?: string[];
  } = {}
): ToolEnvelope<T> {
  return {
    tool,
    executedAt: new Date().toISOString(),
    sourceRecordIds: parts.sourceRecordIds ?? [],
    evidence: parts.evidence ?? [],
    dataLimitations: parts.dataLimitations ?? [],
    data
  };
}

export function fail(
  tool: string,
  code: string,
  message: string,
  retryable = false
): ToolFailure {
  return {
    tool,
    executedAt: new Date().toISOString(),
    error: { code, message, retryable }
  };
}

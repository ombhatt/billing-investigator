import type { EvidenceStatus } from "../types/tools.js";
import type { StepStatus } from "../agent/types.js";

/**
 * Status is always carried by text as well as colour, and each state has a
 * distinct glyph. PRD §8.4 and §21 both forbid colour as the only signal.
 */
const EVIDENCE_GLYPH: Record<EvidenceStatus, string> = {
  confirmed: "✓",
  correlated: "≈",
  not_found: "—",
  unresolved: "!"
};

const EVIDENCE_LABEL: Record<EvidenceStatus, string> = {
  confirmed: "Confirmed",
  correlated: "Correlated",
  not_found: "Not found",
  unresolved: "Unresolved"
};

export function EvidenceStatusBadge({ status }: { status: EvidenceStatus }) {
  return (
    <span className={`badge badge--${status}`}>
      <span aria-hidden="true">{EVIDENCE_GLYPH[status]}</span>
      {EVIDENCE_LABEL[status]}
    </span>
  );
}

const STEP_GLYPH: Record<StepStatus, string> = {
  pending: "·",
  running: "…",
  completed: "✓",
  failed: "✕",
  skipped: "–"
};

const STEP_LABEL: Record<StepStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped"
};

export function StepStatusBadge({ status }: { status: StepStatus }) {
  return (
    <span className={`badge badge--step-${status}`}>
      <span aria-hidden="true">{STEP_GLYPH[status]}</span>
      {STEP_LABEL[status]}
    </span>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence) return null;
  return (
    <span className={`badge badge--confidence-${confidence}`}>
      Confidence: {confidence}
    </span>
  );
}

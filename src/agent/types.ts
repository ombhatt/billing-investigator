import type { EvidenceCard } from "../types/tools.js";
import type { ToolName } from "../tools/catalog.js";
import type { BillingPeriod } from "../domain/units.js";
import type { InvestigationFacts } from "./facts.js";

/** PRD §10.3. */
export type InvestigationState =
  | "created"
  | "clarification_required"
  | "planning"
  | "investigating"
  | "reconciling"
  | "completed"
  | "unresolved"
  | "failed";

export type StepStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PlanStep {
  /** Set on steps that run once per metered service. */
  service?: string;
  id: string;
  /** Only a tool that exists can be planned. Narrowed from the allowlist. */
  tool: ToolName;
  /** User-facing action, never the model's reasoning. PRD §7.2. */
  label: string;
  required: boolean;
  status: StepStatus;
  outcome: string | null;
}

/** PRD §10.4. */
export type HypothesisId = "H1" | "H2" | "H3" | "H4" | "H5" | "H6";
export type HypothesisStatus = "untested" | "supported" | "rejected" | "unresolved";

export interface Hypothesis {
  id: HypothesisId;
  label: string;
  status: HypothesisStatus;
}

/**
 * Per-service effects from the decomposition, which sees every service on the
 * invoice. Used to decide which services need checking and which is the driver
 * worth investigating in depth.
 */
export interface ServiceEffectSummary {
  serviceName: string;
  /** False for fixed-fee lines, which have no usage pipeline to check. */
  metered: boolean;
  totalEffectCents: number;
}

export interface FinalSummary {
  finding: string;
  evidence: string[];
  assessment: string;
  recommendedNextStep: string;
  /** True only when every server-side completion criterion passed. */
  invoiceAppearsCorrect: boolean;
  generatedBy: "model" | "deterministic_fallback";
}

export interface InvestigationRecord {
  investigationId: string;
  accountId: string;
  caseType: "invoice_variance" | null;
  currentPeriod: BillingPeriod | null;
  comparisonPeriod: BillingPeriod | null;
  focusService: string;
  serviceEffects: ServiceEffectSummary[];
  /** Fixed charges with no authorising subscription record. */
  unverifiedFixedCharges: string[];
  state: InvestigationState;
  /**
   * The request that opened the investigation, kept so a clarification reply
   * can be read against it. "August versus July 2026" is only an answer if the
   * question it answers is still available.
   */
  originalQuestion: string | null;
  clarificationQuestion: string | null;
  plan: PlanStep[];
  hypotheses: Hypothesis[];
  evidence: EvidenceCard[];
  facts: InvestigationFacts;
  summary: FinalSummary | null;
  metrics: {
    toolCalls: number;
    cachedToolCalls: number;
    planningCycles: number;
    startedAt: string;
    completedAt: string | null;
  };
  /** Machine-readable reasons the investigation could not complete. */
  blockers: string[];
}

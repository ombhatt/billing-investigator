import { z } from "zod";
import type { EvidenceCard } from "../types/tools.js";
import type { InvestigationFacts } from "../tools/facts.js";
import type { Hypothesis, HypothesisId, HypothesisStatus } from "./types.js";

/**
 * The model is reached only through this interface, which is what lets the
 * whole loop be tested deterministically with a scripted client. PRD §20.3.
 */

export const classificationSchema = z.object({
  caseType: z.literal("invoice_variance"),
  accountId: z.string(),
  currentPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  comparisonPeriod: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().nullable().default(null)
});

export type CaseClassification = z.infer<typeof classificationSchema>;

const hypothesisUpdateSchema = z.object({
  hypothesis: z.enum(["H1", "H2", "H3", "H4", "H5", "H6"]),
  status: z.enum(["untested", "supported", "rejected", "unresolved"])
});

export const planUpdateSchema = z.object({
  nextTools: z.array(z.string()).default([]),
  reason: z.string().default(""),
  hypothesisUpdates: z.array(hypothesisUpdateSchema).default([]),
  done: z.boolean().default(false)
});

export type PlanUpdate = z.infer<typeof planUpdateSchema>;

export interface ClassifyInput {
  question: string;
  boundAccountId: string;
  availablePeriods: string[];
}

export interface PlanInput {
  question: string;
  facts: InvestigationFacts;
  hypotheses: Hypothesis[];
  completedTools: string[];
  availableTools: { tool: string; when: string }[];
  remainingToolBudget: number;
}

export interface ExplainInput {
  question: string;
  facts: InvestigationFacts;
  evidence: EvidenceCard[];
  hypotheses: Hypothesis[];
  invoiceAppearsCorrect: boolean;
  blockers: string[];
  /**
   * "summary" opens the investigation's conclusion; "follow_up" answers a
   * specific later question. They need different prompts: a follow-up that
   * re-summarises the variance is not an answer to "were we charged twice?".
   */
  mode: "summary" | "follow_up";
}

export interface ModelClient {
  classify(input: ClassifyInput): Promise<CaseClassification>;
  planNext(input: PlanInput): Promise<PlanUpdate>;
  explain(input: ExplainInput): Promise<string>;
}

export interface HypothesisUpdate {
  hypothesis: HypothesisId;
  status: HypothesisStatus;
}

/**
 * Used when the model is unavailable or returns unusable output. Keeps the
 * investigation deterministic and complete rather than failing the turn:
 * classification defaults to the bound account and the two most recent periods,
 * and planning asks for every conditional tool.
 */
export class DeterministicModelClient implements ModelClient {
  async classify(input: ClassifyInput): Promise<CaseClassification> {
    const sorted = [...input.availablePeriods].sort();
    const current = sorted.at(-1) ?? "";
    const comparison = sorted.at(-2) ?? "";
    return {
      caseType: "invoice_variance",
      accountId: input.boundAccountId,
      currentPeriod: current,
      comparisonPeriod: comparison,
      needsClarification: false,
      clarificationQuestion: null
    };
  }

  async planNext(input: PlanInput): Promise<PlanUpdate> {
    const remaining = input.availableTools
      .map((t) => t.tool)
      .filter((tool) => !input.completedTools.includes(tool));
    return {
      nextTools: remaining,
      reason: "Deterministic fallback: run every remaining diagnostic check.",
      hypothesisUpdates: [],
      done: remaining.length === 0
    };
  }

  async explain(): Promise<string> {
    // The loop substitutes its deterministic summary when this is returned.
    return "";
  }
}

import { ToolRunner } from "../tools/registry.js";
import type { ToolDeps } from "../tools/createTool.js";
import type { EvidenceCard } from "../types/tools.js";
import type { InvestigationFacts } from "./facts.js";
import { newInvestigation, runInvestigationTurn } from "./loop.js";
import { DeterministicModelClient } from "./modelClient.js";

export interface InvestigationRequest {
  accountId: string;
  currentPeriod: string;
  comparisonPeriod: string;
  focusService: string;
}

export interface InvestigationStep {
  order: number;
  tool: string;
  label: string;
  status: "completed" | "failed";
  summary: string;
}

/**
 * The whole invoice-variance playbook through the real tools against D1, with
 * no language model involved.
 *
 * This used to be a second implementation of the playbook — its own ordering,
 * its own choice of which services to check, its own fact assembly. It drifted
 * from production the moment the agent learned to check pricing and duplicates
 * once per metered service: both agreed on the golden fixture, where nothing is
 * repriced, and disagreed the instant a non-driver service moved.
 *
 * So it is now the same coordinator, driven by `DeterministicModelClient`.
 * "Deterministic" here means no LLM, not a separate playbook. The value of this
 * entry point was never a second opinion about *procedure* — it was proving the
 * read path through repositories and tools, which it still does.
 *
 * The independent second opinion that remains worth having is
 * `analyseInvoiceVariance` in `src/domain/`: different code computing the same
 * money from the same dataset, with no D1 and no tools. Tests assert the two
 * agree exactly.
 */
export async function runInvestigation(
  deps: ToolDeps,
  request: InvestigationRequest
): Promise<{
  facts: InvestigationFacts;
  steps: InvestigationStep[];
  evidence: EvidenceCard[];
  executions: ToolRunner["executions"];
}> {
  const runner = new ToolRunner(deps);

  // Naming both periods in the question is what pins them down: an explicitly
  // named pair is used as given rather than inferred, so the request's periods
  // reach the loop through the same path a user's would.
  const question =
    `Why is account ${request.accountId}'s ${request.currentPeriod} invoice ` +
    `different from ${request.comparisonPeriod}, and is the bill correct?`;

  const record = await runInvestigationTurn(
    newInvestigation(
      `deterministic-${request.currentPeriod}`,
      request.accountId,
      request.focusService
    ),
    question,
    { runner, model: new DeterministicModelClient(), focusService: request.focusService }
  );

  // The loop is built to absorb a failing tool and carry on with a blocker,
  // which is right for a person asking a question and wrong for a verification
  // harness. Here the first failure is the answer.
  const failed = runner.executions.find((e) => "error" in e.result);
  if (failed) {
    const { code, message } = (failed.result as { error: { code: string; message: string } }).error;
    throw new Error(`${failed.tool} failed: ${code} ${message}`);
  }

  if (record.state === "clarification_required") {
    throw new Error(`investigation did not start: ${record.clarificationQuestion}`);
  }

  if (record.currentPeriod !== request.currentPeriod) {
    throw new Error(
      `requested ${request.currentPeriod} but the investigation settled on ${record.currentPeriod}`
    );
  }

  return {
    facts: record.facts,
    evidence: record.evidence,
    executions: runner.executions,
    steps: record.plan
      .filter((s) => s.status === "completed" || s.status === "failed")
      .map((step, index) => ({
        order: index + 1,
        tool: step.tool,
        label: step.label,
        status: step.status as "completed" | "failed",
        summary: step.outcome ?? ""
      }))
  };
}

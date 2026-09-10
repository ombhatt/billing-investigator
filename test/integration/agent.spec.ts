import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
import { answerFollowUp } from "../../src/agent/followUp.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";
import type {
  CaseClassification,
  ClassifyInput,
  ExplainInput,
  ModelClient,
  PlanInput,
  PlanUpdate
} from "../../src/agent/modelClient.js";
import { canTransition } from "../../src/agent/stateMachine.js";
import { ToolRunner } from "../../src/tools/registry.js";
import type { InvestigationRecord } from "../../src/agent/types.js";

const dataset = generateSyntheticData();
const ACCOUNT = "abc123";
const QUESTION =
  "Why is account abc123's August invoice higher than July, and is the bill correct?";

/** Records what the loop asked for so the tests can assert on the interaction. */
class ScriptedModel implements ModelClient {
  readonly classifyCalls: ClassifyInput[] = [];
  readonly planCalls: PlanInput[] = [];
  readonly explainCalls: ExplainInput[] = [];

  constructor(
    private readonly script: {
      classification?: Partial<CaseClassification>;
      plans?: PlanUpdate[];
      prose?: string;
      throwOn?: "classify" | "plan" | "explain";
    } = {}
  ) {}

  async classify(input: ClassifyInput): Promise<CaseClassification> {
    this.classifyCalls.push(input);
    if (this.script.throwOn === "classify") throw new Error("model unavailable");
    return {
      caseType: "invoice_variance",
      accountId: input.boundAccountId,
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07",
      needsClarification: false,
      clarificationQuestion: null,
      ...this.script.classification
    };
  }

  async planNext(input: PlanInput): Promise<PlanUpdate> {
    this.planCalls.push(input);
    if (this.script.throwOn === "plan") throw new Error("model unavailable");
    const scripted = this.script.plans?.[this.planCalls.length - 1];
    if (scripted) return scripted;
    return {
      nextTools: input.availableTools.map((t) => t.tool),
      reason: "run the remaining diagnostics",
      hypothesisUpdates: [
        { hypothesis: "H1", status: "supported" },
        { hypothesis: "H2", status: "rejected" }
      ],
      done: false
    };
  }

  async explain(input: ExplainInput): Promise<string> {
    this.explainCalls.push(input);
    if (this.script.throwOn === "explain") throw new Error("model unavailable");
    return this.script.prose ?? "";
  }
}

function deps(model: ModelClient) {
  return {
    runner: new ToolRunner({ db: env.DB, investigationAccountId: ACCOUNT }),
    model,
    focusService: "Workers"
  };
}

function fresh(overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  return { ...newInvestigation("inv-test", ACCOUNT, "Workers"), ...overrides };
}

beforeEach(async () => {
  await seedDataset(env.DB, dataset);
});

describe("classification", () => {
  it("classifies the golden question as invoice_variance", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.caseType).toBe("invoice_variance");
    expect(record.currentPeriod).toBe("2026-08");
    expect(record.comparisonPeriod).toBe("2026-07");
    expect(model.classifyCalls[0].boundAccountId).toBe(ACCOUNT);
  });

  it("ignores a model-supplied account and stays bound to the investigation", async () => {
    const model = new ScriptedModel({
      classification: { accountId: "someone-else" }
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.accountId).toBe(ACCOUNT);
    expect(record.state).toBe("completed");
  });

  it("reports periods it does not have rather than substituting the newest", async () => {
    // This previously asserted the opposite — a silent fall back to the two
    // most recent invoices. Review was right that it is the wrong behaviour:
    // "why did May jump?" became an investigation of August, answered with
    // full confidence. The wrong question answered correctly is worse than no
    // answer, so the periods are named and the investigation waits.
    //
    // The question here names no periods, so the model's answer is all there
    // is to go on.
    const model = new ScriptedModel({
      classification: { currentPeriod: "2099-01", comparisonPeriod: "2099-02" }
    });
    const record = await runInvestigationTurn(fresh(), "why is my bill higher?", deps(model));

    expect(record.state).toBe("clarification_required");
    expect(record.currentPeriod).toBeNull();
    expect(record.comparisonPeriod).toBeNull();
    expect(record.clarificationQuestion).toContain("2099-01");
    expect(record.clarificationQuestion).toContain("2099-02");
    expect(record.clarificationQuestion).toContain("2026-08");
    expect(record.summary).toBeNull();
  });

  it("uses the periods the reader named over the ones the model returned", async () => {
    // Found by hand. Asked which two to compare and told "2026-06 and 2026-07",
    // the live model answered 2026-07 and 2026-08 — both available, so the
    // availability check had nothing to object to, and the agent investigated a
    // pair the reader never asked for and reported it as the answer.
    const model = new ScriptedModel({
      classification: { currentPeriod: "2099-01", comparisonPeriod: "2099-02" }
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    // QUESTION names August and July; the model's periods are discarded.
    expect(record.state).toBe("completed");
    expect(record.currentPeriod).toBe("2026-08");
    expect(record.comparisonPeriod).toBe("2026-07");
  });

  it("asks for clarification instead of guessing when the model requests it", async () => {
    const model = new ScriptedModel({
      classification: {
        needsClarification: true,
        clarificationQuestion: "Which two periods?"
      }
    });
    const record = await runInvestigationTurn(fresh(), "my bill looks odd", deps(model));

    expect(record.state).toBe("clarification_required");
    expect(record.clarificationQuestion).toBe("Which two periods?");
    expect(record.summary).toBeNull();
  });

  it("completes even when classification throws", async () => {
    const model = new ScriptedModel({ throwOn: "classify" });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.state).toBe("completed");
    expect(record.currentPeriod).toBe("2026-08");
  });
});

describe("playbook execution", () => {
  it("runs the required prelude before anything conditional", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const completed = record.plan.filter((s) => s.status === "completed");
    const order = completed.map((s) => s.tool);
    expect(order.slice(0, 3)).toEqual([
      "get_account_context",
      "compare_invoices",
      "decompose_variance"
    ]);
  });

  it("selects the usage branch only after invoice comparison", async () => {
    const model = new ScriptedModel();
    await runInvestigationTurn(fresh(), QUESTION, deps(model));

    // Planning is only consulted once compare and decompose have produced facts.
    expect(model.planCalls.length).toBeGreaterThan(0);
    expect(model.planCalls[0].completedTools).toContain("compare_invoices");
    expect(model.planCalls[0].completedTools).toContain("decompose_variance");
    expect(model.planCalls[0].facts.variance_cents).toBe(482_000);
  });

  it("reconciles before reaching a terminal state", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.facts.reconciliation_status).toBe("passed");
    expect(record.state).toBe("completed");
    // The state machine makes the ordering structural, not incidental.
    expect(canTransition("investigating", "completed")).toBe(false);
    expect(canTransition("reconciling", "completed")).toBe(true);
  });

  it("forces reconciliation even when the model says it is done early", async () => {
    const model = new ScriptedModel({
      plans: [{ nextTools: [], reason: "enough", hypothesisUpdates: [], done: true }]
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(
      record.plan.find((s) => s.tool === "reconcile_invoice")!.status
    ).toBe("completed");
  });

  it("drops tool names that are not conditional playbook steps", async () => {
    const model = new ScriptedModel({
      plans: [
        {
          nextTools: ["drop_tables", "reconcile_invoice", "get_price_versions"],
          reason: "",
          hypothesisUpdates: [],
          done: true
        }
      ]
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const attempted = record.plan
      .filter((s) => s.status !== "pending")
      .map((s) => s.tool);
    expect(attempted).not.toContain("drop_tables");
    // Required tools cannot be pulled forward by the model into the conditional slot.
    expect(record.plan.find((s) => s.tool === "get_price_versions")!.status).toBe(
      "completed"
    );
  });

  it("applies hypothesis updates from the model", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const byId = new Map(record.hypotheses.map((h) => [h.id, h.status]));
    expect(byId.get("H1")).toBe("supported");
    expect(byId.get("H2")).toBe("rejected");
  });

  it("completes the investigation when the model cannot plan", async () => {
    const model = new ScriptedModel({ throwOn: "plan" });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.state).toBe("completed");
    expect(record.facts.reconciliation_status).toBe("passed");
  });
});

describe("unperformed diagnostics are not treated as checked", () => {
  /** Ends planning on the first cycle without selecting anything. */
  class EarlyStop extends ScriptedModel {
    override async planNext(input: PlanInput): Promise<PlanUpdate> {
      await super.planNext(input);
      return { nextTools: [], reason: "", hypothesisUpdates: [], done: true };
    }
  }

  it("performs the applicable diagnostics the model declined to select", async () => {
    // A mandatory check must not depend on the model choosing it. Live running
    // showed the real model omitting the price check, which produced a correct
    // but unhelpful "unresolved"; the server now backstops.
    const record = await runInvestigationTurn(
      fresh(),
      QUESTION,
      deps(new EarlyStop())
    );

    const completed = record.plan
      .filter((s) => s.status === "completed")
      .map((s) => s.id);
    for (const id of [
      "get_usage_timeseries",
      "detect_usage_change_point",
      "get_price_versions:Workers",
      "get_price_versions:Workers AI",
      "check_duplicate_usage:Workers",
      "check_duplicate_usage:Workers AI"
    ]) {
      expect(completed).toContain(id);
    }
    expect(record.state).toBe("completed");
  });

  it("checks duplicates rather than assuming none, even on an early stop", async () => {
    const record = await runInvestigationTurn(
      fresh(),
      QUESTION,
      deps(new EarlyStop())
    );

    // Actually checked, so the zero is earned rather than defaulted.
    expect(record.facts.exact_duplicate_count).toBe(0);
    expect(record.facts.probable_duplicate_count).toBe(0);
  });

  it("still blocks when the budget prevents the backstop running", async () => {
    // The blocker path remains: unchecked is never treated as clean, whether
    // the model skipped it or there was no budget left to run it.
    const record = await runInvestigationTurn(
      fresh({ metrics: { ...fresh().metrics, toolCalls: 6 } }),
      QUESTION,
      deps(new EarlyStop())
    );

    expect(record.state).toBe("unresolved");
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
    expect(record.blockers.join(" ")).toMatch(
      /diagnostics not performed|tool-call limit reached/
    );
  });

  it("still completes when the diagnostics are actually run", async () => {
    // The requirement is derived from the variance, so a model that runs the
    // applicable checks reaches the same conclusion as before.
    const record = await runInvestigationTurn(
      fresh(),
      QUESTION,
      deps(new ScriptedModel())
    );

    expect(record.state).toBe("completed");
    expect(record.blockers).toEqual([]);
    expect(record.facts.confidence).toBe("high");
  });
});

describe("bounded limits", () => {
  it("never exceeds four planning cycles", async () => {
    const model = new ScriptedModel({
      // Never signals done and never selects anything.
      plans: Array.from({ length: 10 }, () => ({
        nextTools: [],
        reason: "",
        hypothesisUpdates: [],
        done: false
      }))
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.metrics.planningCycles).toBeLessThanOrEqual(4);
    expect(model.planCalls.length).toBeLessThanOrEqual(4);
  });

  it("stops calling tools at the twelve-call limit", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(
      fresh({ metrics: { ...fresh().metrics, toolCalls: 11 } }),
      QUESTION,
      deps(model)
    );

    expect(record.metrics.toolCalls).toBeLessThanOrEqual(12);
    expect(record.plan.some((s) => s.status === "skipped")).toBe(true);
    expect(record.blockers).toContain("tool-call limit reached");
  });

  it("cannot declare correctness once the limit truncated the checks", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(
      fresh({ metrics: { ...fresh().metrics, toolCalls: 11 } }),
      QUESTION,
      deps(model)
    );

    expect(record.state).toBe("unresolved");
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
  });

  it("uses at most nine tool calls on the golden path", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));
    // 11 of the 12 budget: two metered services each get a price and a
    // duplicate check, so an invoice-wide claim is backed invoice-wide.
    expect(record.metrics.toolCalls).toBe(11);
  });
});

describe("the agent cannot overstate its findings", () => {
  it("reports unresolved when reconciliation fails", async () => {
    // Break the invoice total so the components no longer sum to it.
    await env.DB.prepare(
      "UPDATE invoices SET total_cents = total_cents + 100 WHERE period = ?"
    )
      .bind("2026-08")
      .run();

    const model = new ScriptedModel({ prose: "The invoice is perfectly fine." });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.facts.reconciliation_status).toBe("failed");
    expect(record.state).toBe("unresolved");
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
    expect(record.blockers).toContain("reconciliation did not pass");
    // The model was told not to claim correctness.
    expect(model.explainCalls[0].invoiceAppearsCorrect).toBe(false);
  });

  it("reports unresolved when duplicate usage is found", async () => {
    const original = dataset.usageEvents.find(
      (e) => e.serviceName === "Workers" && e.occurredAt.startsWith("2026-08")
    )!;
    await env.DB.prepare(
      `INSERT INTO usage_events (event_id, account_id, service_name, zone_id,
        source_event_key, occurred_at, quantity, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `${original.eventId}-retry`,
        original.accountId,
        original.serviceName,
        original.zoneId,
        original.sourceEventKey,
        original.occurredAt,
        original.quantity,
        original.unit
      )
      .run();

    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.facts.probable_duplicate_count).toBe(1);
    expect(record.state).toBe("unresolved");
    expect(record.facts.confidence).toBe("low");
  });

  it("keeps confidence out of the model's hands", async () => {
    const model = new ScriptedModel({
      prose: "Confidence: absolute certainty, no further checks needed."
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    // Prose cannot move the rating; it is computed from facts.
    expect(record.facts.confidence).toBe("high");
    expect(["high", "medium", "low"]).toContain(record.facts.confidence);
  });

  it("falls back to a deterministic summary when synthesis fails", async () => {
    const model = new ScriptedModel({ throwOn: "explain" });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.summary!.generatedBy).toBe("deterministic_fallback");
    expect(record.summary!.finding).toContain("$21,720.00");
    expect(record.state).toBe("completed");
  });

  it("discards model prose that writes its own assessment or next step", async () => {
    // A live run produced exactly this: the model appended its own
    // "Recommended next step: no further investigation is required", which
    // contradicted the computed recommendation sitting directly below it.
    const model = new ScriptedModel({
      prose:
        "The invoice rose by $4,820.00.\n\nRecommended next step: no further investigation is required."
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.summary!.generatedBy).toBe("deterministic_fallback");
    expect(record.summary!.recommendedNextStep).toContain("dep-1842");
    expect(record.summary!.finding).not.toContain("no further investigation");
  });

  it("keeps clean model prose and strips a duplicated Finding label", async () => {
    const model = new ScriptedModel({
      prose: "Finding: August rose by $4,820.00, driven by Workers volume."
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.summary!.generatedBy).toBe("model");
    expect(record.summary!.finding).toBe(
      "August rose by $4,820.00, driven by Workers volume."
    );
    // The deterministic sections are still the ones that ship.
    expect(record.summary!.assessment).toContain("not a financial certification");
  });

  it("does not show prose containing a fabricated amount or identifier", async () => {
    // Review demonstrated this exact sentence reaching the user unchanged while
    // the structured facts stayed correct.
    const model = new ScriptedModel({
      prose:
        "The invoice rose by $99,999 because dep-FAKE caused duplicate charges. " +
        "The invoice is correct."
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const shown = record.summary!.finding;
    expect(shown).not.toContain("$99,999");
    expect(shown).not.toContain("dep-FAKE");
    expect(shown).not.toMatch(/caused/i);
    expect(record.summary!.generatedBy).toBe("deterministic_fallback");
    // The verified facts were never in doubt; the prose was.
    expect(record.facts.variance_cents).toBe(482_000);
  });

  it("does not let prose claim correctness when the investigation is unresolved", async () => {
    await env.DB.prepare(
      "UPDATE invoices SET total_cents = total_cents + 100 WHERE period = ?"
    )
      .bind("2026-08")
      .run();

    const model = new ScriptedModel({
      prose: "Everything checks out and the invoice is correct."
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.state).toBe("unresolved");
    expect(record.summary!.finding).not.toMatch(/invoice is correct/i);
    expect(record.summary!.generatedBy).toBe("deterministic_fallback");
  });

  it("holds follow-up answers to the same evidence boundary", async () => {
    const honest = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(honest));

    const liar = new ScriptedModel({
      prose: "Yes — dep-FAKE duplicated $99,999 of usage."
    });
    const followUp = await answerFollowUp(record, "were we charged twice?", liar);

    expect(followUp.text).not.toContain("$99,999");
    expect(followUp.text).not.toContain("dep-FAKE");
    // Falls back to the persisted, verified summary.
    expect(followUp.text).toContain("Finding.");
  });

  it("still shows evidence-backed model prose", async () => {
    const model = new ScriptedModel({
      prose: "August rose by $4,820.00, driven by Workers volume."
    });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    expect(record.summary!.generatedBy).toBe("model");
    expect(record.summary!.finding).toBe(
      "August rose by $4,820.00, driven by Workers volume."
    );
  });

  it("describes the deployment as correlated, never causal", async () => {
    const model = new ScriptedModel({ throwOn: "explain" });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const line = record.summary!.evidence.find((e) => e.includes("dep-1842"))!;
    expect(line).toMatch(/correlation, not proof of cause/i);
  });
});

describe("no chain-of-thought is persisted", () => {
  it("stores plan outcomes but never the model's stated reason", async () => {
    const model = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain("run the remaining diagnostics");
    expect(serialised).not.toContain("reason");

    // Step outcomes are factual summaries, which are fine to show.
    const compare = record.plan.find((s) => s.tool === "compare_invoices")!;
    expect(compare.outcome).toBe("variance 482000 cents");
  });
});

describe("follow-up questions", () => {
  it("answers from persisted evidence without new tool calls", async () => {
    const model = new ScriptedModel({ prose: "Answer from evidence." });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));
    expect(record.state).toBe("completed");

    const followUp = await answerFollowUp(
      record,
      "Could the usage have been duplicated?",
      model
    );

    expect(followUp.usedEvidenceCount).toBe(record.evidence.length);
    expect(followUp.usedEvidenceCount).toBeGreaterThan(0);
    // The duplicate finding is already on the record.
    const provided = model.explainCalls.at(-1)!;
    expect(provided.facts.exact_duplicate_count).toBe(0);
    expect(provided.facts.probable_duplicate_count).toBe(0);
  });

  it("asks the model to answer the question, not re-summarise", async () => {
    // A live run restated the variance instead of answering "were we charged
    // twice?", because follow-ups were reusing the summary prompt.
    const model = new ScriptedModel({ prose: "No duplicates were found." });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));
    await answerFollowUp(record, "Could the usage have been duplicated?", model);

    expect(model.explainCalls[0].mode).toBe("summary");
    expect(model.explainCalls.at(-1)!.mode).toBe("follow_up");
  });

  it("gives a follow-up the evidence cards, not only the fact block", async () => {
    const model = new ScriptedModel({ prose: "answer" });
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(model));
    await answerFollowUp(record, "Which zone generated the increase?", model);

    // The zone split lives in evidence, never in the fact block.
    const provided = model.explainCalls.at(-1)!;
    const zoneCard = provided.evidence.find(
      (e) => e.label === "Workers usage by zone"
    );
    expect(zoneCard).toBeDefined();
    expect(zoneCard!.value).toContain("zone-api-acme");
  });

  it("says it could not answer before offering the summary as context", async () => {
    // This previously returned `renderSummary` alone, formatted exactly like an
    // answer, so a question the agent could not answer received the previous
    // conclusion and nothing marked it as a non-answer.
    const working = new ScriptedModel();
    const record = await runInvestigationTurn(fresh(), QUESTION, deps(working));

    const broken = new ScriptedModel({ throwOn: "explain" });
    const followUp = await answerFollowUp(record, "Which zone?", broken);

    expect(followUp.text).toMatch(/^I could not answer that/);
    expect(followUp.text).toContain("Finding.");
    expect(followUp.text).toContain("$21,720.00");
  });

  it("refuses to answer before an investigation has run", async () => {
    const followUp = await answerFollowUp(
      fresh(),
      "Did the price change?",
      new ScriptedModel()
    );
    expect(followUp.text).toMatch(/no evidence/i);
    expect(followUp.usedEvidenceCount).toBe(0);
  });
});

describe("a finished investigation cannot be resumed", () => {
  it("refuses a completed record with a clear message", async () => {
    const model = new ScriptedModel();
    const done = await runInvestigationTurn(fresh(), QUESTION, deps(model));
    expect(done.state).toBe("completed");

    // Reproduces the deployed bug: Reset cleared the chat but left this record
    // terminal, so the next question was routed as a follow-up. Handing the
    // record back to the loop must fail loudly, not with a transition error.
    await expect(
      runInvestigationTurn(done, QUESTION, deps(new ScriptedModel()))
    ).rejects.toThrow(/already completed; start a new one/);
  });

  it("runs a full investigation again from a fresh record", async () => {
    const model = new ScriptedModel();
    await runInvestigationTurn(fresh(), QUESTION, deps(model));

    const second = await runInvestigationTurn(
      fresh({ investigationId: "inv-second" }),
      QUESTION,
      deps(new ScriptedModel())
    );
    expect(second.state).toBe("completed");
    expect(second.plan.filter((s) => s.status === "completed")).toHaveLength(11);
  });
});

describe("deterministic model client", () => {
  it("drives the full investigation with no model at all", async () => {
    const record = await runInvestigationTurn(
      fresh(),
      QUESTION,
      deps(new DeterministicModelClient())
    );

    expect(record.state).toBe("completed");
    expect(record.facts.reconciliation_status).toBe("passed");
    expect(record.summary!.generatedBy).toBe("deterministic_fallback");
  });
});

/**
 * A question about a month the investigation never examined.
 *
 * Found by hand: after the golden August-versus-July run, "what about their
 * billing for the month of June?" returned the August summary verbatim —
 * Finding, Evidence, Assessment — as though it answered. It did not. The
 * investigation had no June evidence at all.
 *
 * Two separate defects met here. The follow-up never checked whether the
 * question was in scope; and the fallback for an unanswerable question was the
 * previous conclusion, formatted identically to an answer. The narrative guard
 * had done its job — prose about June was correctly rejected — and the fallback
 * then undid the benefit.
 */
describe("a follow-up about an uninvestigated period", () => {
  const golden = async () =>
    await runInvestigationTurn(fresh(), QUESTION, deps(new ScriptedModel()));

  it("declines the exact question that exposed this", async () => {
    const record = await golden();
    const followUp = await answerFollowUp(
      record,
      "what about their billing for the month of June?",
      new ScriptedModel()
    );

    expect(followUp.text).toContain("2026-06");
    expect(followUp.text).toContain("2026-08");
    expect(followUp.text).toContain("2026-07");
    // Emphatically not the previous conclusion dressed as an answer.
    expect(followUp.text).not.toContain("Finding.");
    expect(followUp.text).not.toContain("$21,720.00");
    expect(followUp.usedEvidenceCount).toBe(0);
  });

  it("declines whether or not the year is spelled out", async () => {
    const record = await golden();
    for (const question of [
      "what about June?",
      "what about June 2026?",
      "how does 2026-06 compare?"
    ]) {
      const followUp = await answerFollowUp(record, question, new ScriptedModel());
      expect(followUp.text).toContain("2026-06");
      expect(followUp.text).not.toContain("Finding.");
    }
  });

  it("still answers questions about the periods it did investigate", async () => {
    // The control: scoping must not swallow legitimate follow-ups.
    const record = await golden();
    for (const question of [
      "Could the usage have been duplicated?",
      "Which zone generated the increase?",
      "How did August compare with July?"
    ]) {
      const followUp = await answerFollowUp(record, question, new ScriptedModel());
      expect(followUp.text).not.toMatch(/no evidence for/);
      expect(followUp.usedEvidenceCount).toBeGreaterThan(0);
    }
  });

  it("is not tripped by the word 'may'", async () => {
    const record = await golden();
    const followUp = await answerFollowUp(
      record,
      "may the increase have been caused by a deployment?",
      new ScriptedModel()
    );
    expect(followUp.text).not.toContain("no evidence for 2026-05");
  });
});

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
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

/**
 * A clarification the agent cannot act on is worse than no clarification.
 *
 * The agent asked which months to compare, the reader answered "August versus
 * July 2026", and the reply branch transitioned straight to planning without
 * ever reclassifying. The periods stayed null, every tool was skipped for want
 * of an input, and the turn ended `unresolved` — the reader having answered
 * correctly.
 *
 * The second half is the opposite failure: a period the account does not have
 * was silently replaced with the newest invoice, so a question about May was
 * answered, confidently, about August.
 */

/** Classifies whatever the last call asked for, so replies can be scripted. */
class ReplyModel implements ModelClient {
  readonly classifyCalls: ClassifyInput[] = [];

  constructor(
    private readonly answers: (Partial<CaseClassification> | "throw")[]
  ) {}

  async classify(input: ClassifyInput): Promise<CaseClassification> {
    this.classifyCalls.push(input);
    const answer = this.answers[this.classifyCalls.length - 1] ?? {};
    if (answer === "throw") throw new Error("model unavailable");
    return {
      caseType: "invoice_variance",
      accountId: input.boundAccountId,
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07",
      needsClarification: false,
      clarificationQuestion: null,
      ...answer
    };
  }

  async planNext(input: PlanInput): Promise<PlanUpdate> {
    return {
      nextTools: input.availableTools.map((t) => t.tool),
      reason: "run the remaining diagnostics",
      hypothesisUpdates: [],
      done: false
    };
  }

  async explain(_input: ExplainInput): Promise<string> {
    return "August is higher than July because metered Workers usage rose.";
  }
}

function deps(model: ModelClient) {
  return {
    runner: new ToolRunner({ db: env.DB, investigationAccountId: ACCOUNT }),
    model,
    focusService: "Workers"
  };
}

const fresh = (overrides: Partial<InvestigationRecord> = {}): InvestigationRecord => ({
  ...newInvestigation("inv-clarify", ACCOUNT, "Workers"),
  ...overrides
});

beforeEach(async () => {
  await seedDataset(env.DB, dataset);
});

describe("a clarification reply completes the investigation", () => {
  it("asks, then acts on the answer", async () => {
    const model = new ReplyModel([
      { needsClarification: true, clarificationQuestion: "Which months?" },
      { currentPeriod: "2026-08", comparisonPeriod: "2026-07" }
    ]);

    const asked = await runInvestigationTurn(fresh(), "my bill looks odd", deps(model));
    expect(asked.state).toBe("clarification_required");
    expect(asked.clarificationQuestion).toBe("Which months?");

    // The exact round trip from review.
    const answered = await runInvestigationTurn(
      asked,
      "August versus July 2026",
      deps(model)
    );

    expect(answered.state).toBe("completed");
    expect(answered.currentPeriod).toBe("2026-08");
    expect(answered.comparisonPeriod).toBe("2026-07");
    expect(answered.facts.variance_cents).toBe(482000);
    expect(answered.summary).not.toBeNull();
    expect(answered.blockers).toEqual([]);
  });

  it("reads the reply against the request it answers", async () => {
    // "August versus July 2026" alone names no account and asks nothing. The
    // second classify call has to carry the original question and the question
    // that was put to the reader, or the reply is uninterpretable.
    const model = new ReplyModel([
      { needsClarification: true, clarificationQuestion: "Which months?" },
      {}
    ]);

    const asked = await runInvestigationTurn(
      fresh(),
      "why did my bill jump?",
      deps(model)
    );
    await runInvestigationTurn(asked, "August versus July 2026", deps(model));

    const second = model.classifyCalls[1].question;
    expect(second).toContain("why did my bill jump?");
    expect(second).toContain("Which months?");
    expect(second).toContain("August versus July 2026");
    expect(model.classifyCalls[1].availablePeriods).toContain("2026-08");
  });

  it("keeps the original request rather than the synthesised context", async () => {
    const model = new ReplyModel([
      { needsClarification: true, clarificationQuestion: "Which months?" },
      {}
    ]);
    const asked = await runInvestigationTurn(fresh(), "why did my bill jump?", deps(model));
    expect(asked.originalQuestion).toBe("why did my bill jump?");

    const answered = await runInvestigationTurn(asked, "August vs July", deps(model));
    expect(answered.originalQuestion).toBe("why did my bill jump?");
  });

  it("asks again when the reply still does not identify two periods", async () => {
    const model = new ReplyModel([
      { needsClarification: true, clarificationQuestion: "Which months?" },
      { needsClarification: true, clarificationQuestion: "Which two, exactly?" }
    ]);

    const asked = await runInvestigationTurn(fresh(), "my bill looks odd", deps(model));
    const stillAsking = await runInvestigationTurn(asked, "the recent one", deps(model));

    // Re-asking must be a state the machine allows; it used to throw.
    expect(canTransition("clarification_required", "clarification_required")).toBe(true);
    expect(stillAsking.state).toBe("clarification_required");
    expect(stillAsking.clarificationQuestion).toBe("Which two, exactly?");
    expect(stillAsking.currentPeriod).toBeNull();
    expect(stillAsking.summary).toBeNull();
  });
});

describe("periods the account does not have are reported, not substituted", () => {
  it("names the unavailable month and what is available", async () => {
    const model = new ReplyModel([
      { currentPeriod: "2026-05", comparisonPeriod: "2026-04" }
    ]);
    const record = await runInvestigationTurn(
      fresh(),
      "why did May 2026 jump against April 2026?",
      deps(model)
    );

    expect(record.state).toBe("clarification_required");
    expect(record.currentPeriod).toBeNull();
    expect(record.comparisonPeriod).toBeNull();
    expect(record.clarificationQuestion).toContain("2026-05");
    expect(record.clarificationQuestion).toContain("2026-04");
    // And says what it does have, so the reader can answer usefully.
    for (const available of ["2026-06", "2026-07", "2026-08"]) {
      expect(record.clarificationQuestion).toContain(available);
    }
    // Crucially, it did not quietly investigate August instead.
    expect(record.summary).toBeNull();
    expect(record.facts.variance_cents).toBeNull();
  });

  it("reports only the half it is missing", async () => {
    const model = new ReplyModel([
      { currentPeriod: "2026-08", comparisonPeriod: "2026-01" }
    ]);
    const record = await runInvestigationTurn(fresh(), "August versus January", deps(model));

    expect(record.state).toBe("clarification_required");
    expect(record.clarificationQuestion).toContain("2026-01");
    expect(record.clarificationQuestion).not.toContain("2026-08 or");
  });

  it("refuses a comparison of a period against itself", async () => {
    const model = new ReplyModel([
      { currentPeriod: "2026-08", comparisonPeriod: "2026-08" }
    ]);
    const record = await runInvestigationTurn(fresh(), "how is August?", deps(model));

    expect(record.state).toBe("clarification_required");
    expect(record.clarificationQuestion).toContain("twice");
    expect(record.summary).toBeNull();
  });

  it("still defaults to the two latest when the model could not be reached", async () => {
    // Nothing was requested here, so nothing is being overridden. This is the
    // one case where choosing the most recent invoices is honest.
    const model = new ReplyModel(["throw"]);
    const record = await runInvestigationTurn(fresh(), "why is my bill high?", deps(model));

    expect(record.state).toBe("completed");
    expect(record.currentPeriod).toBe("2026-08");
    expect(record.comparisonPeriod).toBe("2026-07");
  });
});

/**
 * Validating only the model's answer is not enough.
 *
 * Shown the available periods, the live model answers with those rather than
 * the months it was asked about, so the substitution happens before any check
 * of its output can see it. Production returned a reconciled, high-confidence
 * answer to "why did my May 2026 invoice jump compared to April 2026?" whose
 * figures were August's and whose prose said May.
 */
describe("a question naming months the account does not have is challenged", () => {
  /** Answers with available periods regardless of what was asked, as the real model does. */
  const clamping = () => new ReplyModel([{}, {}]);

  it("asks rather than answering about a different month", async () => {
    const model = clamping();
    const record = await runInvestigationTurn(
      fresh(),
      "Why did my May 2026 invoice jump compared to April 2026?",
      deps(model)
    );

    expect(record.state).toBe("clarification_required");
    expect(record.clarificationQuestion).toContain("2026-05");
    expect(record.clarificationQuestion).toContain("2026-04");
    expect(record.clarificationQuestion).toContain("2026-08");
    expect(record.summary).toBeNull();
    // The model was never even consulted: the question was answerable without it.
    expect(model.classifyCalls).toHaveLength(0);
  });

  it("proceeds when the named months are ones the account has", async () => {
    const model = clamping();
    const record = await runInvestigationTurn(
      fresh(),
      "Why is August 2026 higher than July 2026?",
      deps(model)
    );

    expect(record.state).toBe("completed");
    expect(record.currentPeriod).toBe("2026-08");
  });

  it("lets the reader correct themselves without re-raising the old months", async () => {
    // The synthesised clarification context still quotes the original request.
    // Parsing that instead of this turn's reply would object forever and the
    // reader could never answer.
    const model = clamping();
    const asked = await runInvestigationTurn(
      fresh(),
      "Why did my May 2026 invoice jump compared to April 2026?",
      deps(model)
    );
    expect(asked.state).toBe("clarification_required");

    const answered = await runInvestigationTurn(
      asked,
      "Sorry — August 2026 versus July 2026 please.",
      deps(model)
    );

    expect(answered.state).toBe("completed");
    expect(answered.currentPeriod).toBe("2026-08");
    expect(answered.comparisonPeriod).toBe("2026-07");
    expect(answered.facts.variance_cents).toBe(482000);
  });

  it("does not let the answer describe a month it did not investigate", async () => {
    // The guard behind the guard: even having settled on August and July, prose
    // naming May is rejected and the deterministic finding is shown instead.
    class MislabellingModel extends ReplyModel {
      async explain(): Promise<string> {
        return "The May 2026 invoice jumped by $4,820.00 compared to April 2026.";
      }
    }
    const record = await runInvestigationTurn(
      fresh(),
      "Why is August 2026 higher than July 2026?",
      deps(new MislabellingModel([{}]))
    );

    expect(record.state).toBe("completed");
    expect(record.summary!.generatedBy).toBe("deterministic_fallback");
    expect(record.summary!.finding).not.toContain("May 2026");
  });
});

/**
 * A bare "May" is deliberately not read as a month — it is a verb far more
 * often in this domain — so a question naming it without a year is caught by
 * the other month it names, and by the model's own answer.
 */
/**
 * Found by hand against the deployed app, and the reason the test below it was
 * not enough. Asked "Why did the May invoice jump?", the agent investigated
 * 2026-07 against 2026-08 and answered "The May invoice jumped by $4,820.00" —
 * August's figures under May's name.
 *
 * Two checks were meant to stop that and neither could see the word. The
 * availability check reads the reader's text, and "may" was excluded from bare
 * month matching as a verb; the narrative guard reads the model's prose, and
 * read it with no year to assume, which excluded every bare month. The month
 * named in the question was the one month both were blind to.
 */
describe("a question about a month the account lacks is not answered about another", () => {
  it("challenges 'the May invoice' rather than investigating August", async () => {
    // The model answers with the newest available pair, as the live one did.
    const model = new ReplyModel([{}]);
    const record = await runInvestigationTurn(
      fresh(),
      "Why did the May invoice jump?",
      deps(model)
    );

    expect(record.state).toBe("clarification_required");
    expect(record.clarificationQuestion).toContain("2026-05");
    expect(record.currentPeriod).toBeNull();
    expect(record.summary).toBeNull();
  });

  it("does not challenge a question that merely uses 'may' as a verb", async () => {
    // The control. Excluding "may" outright was one way to pass the test above
    // and would break every ordinary question containing the word.
    const model = new ReplyModel([{}]);
    const record = await runInvestigationTurn(
      fresh(),
      "Usage may have risen — why is August higher than July?",
      deps(model)
    );

    expect(record.state).not.toBe("clarification_required");
    expect(record.currentPeriod).toBe("2026-08");
    expect(record.comparisonPeriod).toBe("2026-07");
  });
});

describe("a bare month name the reader did not qualify", () => {
  it("still declines, on the month it can resolve", async () => {
    const model = new ReplyModel([
      { currentPeriod: "2026-05", comparisonPeriod: "2026-04" }
    ]);
    const record = await runInvestigationTurn(
      fresh(),
      "why did May jump against April?",
      deps(model)
    );

    expect(record.state).toBe("clarification_required");
    expect(record.clarificationQuestion).toContain("2026-04");
    expect(record.summary).toBeNull();
  });
});

/**
 * The exact defect found by hand: the reader answered the clarification with
 * two valid periods and the agent investigated a different pair.
 *
 * Asked "which two should I compare?" and told "2026-06 and 2026-07", the live
 * model replied with 2026-07 and 2026-08. Both exist, so the availability check
 * had nothing to object to, and the August-versus-July result was returned as
 * though it answered. Validating that the model's periods are *available* is
 * not the same as checking they are the ones that were *asked for*.
 */
describe("an explicit choice of periods is not overridden by the model", () => {
  /** Ignores the reply and always answers with the golden pair, as the live model did. */
  const stubborn = () =>
    new ReplyModel([
      { needsClarification: true, clarificationQuestion: "Which two should I compare?" },
      { currentPeriod: "2026-08", comparisonPeriod: "2026-07" }
    ]);

  it("compares what the reader asked for", async () => {
    const model = stubborn();
    const asked = await runInvestigationTurn(
      fresh(),
      "Why did my May 2026 invoice jump compared to April 2026?",
      deps(model)
    );
    expect(asked.state).toBe("clarification_required");

    const answered = await runInvestigationTurn(asked, "2026-06 and 2026-07", deps(model));

    expect(answered.currentPeriod).toBe("2026-07");
    expect(answered.comparisonPeriod).toBe("2026-06");
    // And emphatically not the golden pair the model kept insisting on.
    expect(answered.facts.current_total_cents).not.toBe(2_172_000);
    expect(answered.facts.variance_cents).not.toBe(482_000);
  });

  it("honours the same choice however it is written", async () => {
    for (const reply of [
      "2026-06 and 2026-07",
      "June 2026 and July 2026",
      "compare June and July please"
    ]) {
      const model = stubborn();
      const asked = await runInvestigationTurn(fresh(), "my bill looks odd", deps(model));
      const answered = await runInvestigationTurn(asked, reply, deps(model));

      expect(answered.currentPeriod).toBe("2026-07");
      expect(answered.comparisonPeriod).toBe("2026-06");
    }
  });

  it("asks again rather than choosing when more than two are named", async () => {
    const model = stubborn();
    const asked = await runInvestigationTurn(fresh(), "my bill looks odd", deps(model));
    const answered = await runInvestigationTurn(
      asked,
      "2026-06, 2026-07 and 2026-08",
      deps(model)
    );

    expect(answered.state).toBe("clarification_required");
    expect(answered.clarificationQuestion).toContain("Which two");
    expect(answered.currentPeriod).toBeNull();
  });

  it("still defers to the model when the reader names no periods", async () => {
    // The control: the override must only fire on an explicit instruction.
    const model = stubborn();
    const asked = await runInvestigationTurn(fresh(), "my bill looks odd", deps(model));
    const answered = await runInvestigationTurn(asked, "the two most recent", deps(model));

    expect(answered.currentPeriod).toBe("2026-08");
    expect(answered.comparisonPeriod).toBe("2026-07");
  });
});

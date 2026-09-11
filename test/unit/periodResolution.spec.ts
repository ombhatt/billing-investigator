import { per } from "../support/values.js";
import { describe, expect, it } from "vitest";
import {
  clarificationContext,
  periodsNamed,
  resolvePeriods
} from "../../src/agent/periodResolution.js";
import type { CaseClassification } from "../../src/agent/modelClient.js";
import type { InvestigationRecord } from "../../src/agent/types.js";

/**
 * Reading a request, tested without a database, a model, or a playbook.
 *
 * Three separate defects have lived in this logic — a clarification reply that
 * was never reclassified, an unavailable month silently swapped for the newest
 * invoice, and an explicit pair overridden by the model's own choice. All three
 * are about interpreting a request, and none of them needs a tool to reproduce.
 * Until now they could only be exercised through a full investigation.
 */

const AVAILABLE = ["2026-06", "2026-07", "2026-08"];

const classified = (
  overrides: Partial<CaseClassification> = {}
): CaseClassification => ({
  caseType: "invoice_variance",
  accountId: "abc123",
  currentPeriod: "2026-08",
  comparisonPeriod: "2026-07",
  needsClarification: false,
  clarificationQuestion: null,
  ...overrides
});

describe("reading periods out of a request", () => {
  it("takes an explicit pair however it is written", () => {
    for (const text of [
      "2026-06 and 2026-07",
      "June 2026 and July 2026",
      "compare June and July please"
    ]) {
      expect(periodsNamed(text, AVAILABLE.map((p) => per(p))), text).toEqual([per("2026-06"), per("2026-07")]);
    }
  });

  it("only infers a year the account actually has invoices in", () => {
    // "August" with no year cannot become 2025-08 when the account's invoices
    // are all 2026.
    expect(periodsNamed("August versus July", AVAILABLE.map((p) => per(p)))).toEqual([
      "2026-07",
      "2026-08"
    ]);
    expect(periodsNamed("August versus July", [])).toEqual([]);
  });

  it("finds nothing in a request that names no month", () => {
    expect(periodsNamed("why is my bill higher?", AVAILABLE.map((p) => per(p)))).toEqual([]);
  });
});

describe("choosing which two periods to compare", () => {
  it("uses the pair the reader named, over the model's own answer", () => {
    // The defect found by hand: told "2026-06 and 2026-07", the live model
    // answered 2026-07 and 2026-08 — both available, so nothing objected.
    const choice = resolvePeriods(classified(), AVAILABLE, [per("2026-06"), per("2026-07")]);

    expect(choice).toEqual({
      currentPeriod: "2026-07",
      comparisonPeriod: "2026-06"
    });
  });

  it("reads the later of the named pair as the current period", () => {
    const choice = resolvePeriods(null, AVAILABLE, [per("2026-06"), per("2026-08")]);
    expect(choice).toEqual({
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-06"
    });
  });

  it("asks rather than picking when more than two are named", () => {
    const choice = resolvePeriods(classified(), AVAILABLE, AVAILABLE.map((p) => per(p)));
    expect(choice).toHaveProperty("clarify");
    expect((choice as { clarify: string }).clarify).toContain("Which two");
  });

  it("reports a period the account does not have, rather than substituting", () => {
    const choice = resolvePeriods(
      classified({ currentPeriod: "2026-05", comparisonPeriod: "2026-04" }),
      AVAILABLE,
      []
    );

    const { clarify } = choice as { clarify: string };
    expect(clarify).toContain("2026-05");
    expect(clarify).toContain("2026-04");
    // And says what it does have, so the reader can answer usefully.
    for (const period of AVAILABLE) expect(clarify).toContain(period);
  });

  it("refuses a period compared against itself", () => {
    const choice = resolvePeriods(
      classified({ currentPeriod: "2026-08", comparisonPeriod: "2026-08" }),
      AVAILABLE,
      []
    );
    expect((choice as { clarify: string }).clarify).toContain("twice");
  });

  it("passes the model's request for clarification straight through", () => {
    const choice = resolvePeriods(
      classified({ needsClarification: true, clarificationQuestion: "Which months?" }),
      AVAILABLE,
      []
    );
    expect(choice).toEqual({ clarify: "Which months?" });
  });

  it("falls back to the two latest only when the model could not be reached", () => {
    // Nothing was requested, so nothing is being overridden. This is the one
    // case where choosing for the reader is honest.
    expect(resolvePeriods(null, AVAILABLE, [])).toEqual({
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07"
    });
  });

  it("says plainly when there is nothing to compare", () => {
    expect(resolvePeriods(classified(), [], [])).toEqual({
      clarify: "I have no invoices for this account, so there is nothing to compare."
    });
    expect(
      (resolvePeriods(classified(), ["2026-08"], []) as { clarify: string }).clarify
    ).toContain("2026-08");
  });
});

describe("reading a clarification reply", () => {
  it("carries the original request and the question that was asked", () => {
    // "August versus July 2026" names no account and asks nothing. On its own
    // it is uninterpretable.
    const record = {
      originalQuestion: "why did my bill jump?",
      clarificationQuestion: "Which months?"
    } as InvestigationRecord;

    const context = clarificationContext(record, "August versus July 2026");

    expect(context).toContain("why did my bill jump?");
    expect(context).toContain("Which months?");
    expect(context).toContain("August versus July 2026");
  });

  it("still reads when the record has no remembered question", () => {
    const record = {
      originalQuestion: null,
      clarificationQuestion: null
    } as InvestigationRecord;

    const context = clarificationContext(record, "August and July");
    expect(context).toContain("August and July");
    expect(context).toContain("billing periods");
  });
});

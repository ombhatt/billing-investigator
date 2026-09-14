import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import {
  DUPLICATE_USAGE_ACCOUNT,
  GOLDEN_ACCOUNT
} from "../../seed/constants.js";
import { seedDataset } from "./seedD1.js";
import { DUPLICATE_FACTS } from "../support/duplicateFacts.js";
import { GOLDEN_FACTS } from "../support/goldenFacts.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";
import { goldenFacts } from "../../src/domain/invoiceVarianceCase.js";
import { ToolRunner } from "../../src/tools/registry.js";
import { renderSummary } from "../../src/agent/summary.js";
import { per } from "../support/values.js";

const golden = generateSyntheticData(GOLDEN_ACCOUNT);
const duplicate = generateSyntheticData(DUPLICATE_USAGE_ACCOUNT);
const ACCOUNT = "dup-7741";
const QUESTION =
  "Why is account dup-7741's August invoice higher than July, and is the bill correct?";

beforeEach(async () => {
  await seedDataset(env.DB, golden, duplicate);
});

function run(accountId = ACCOUNT) {
  return runInvestigationTurn(
    newInvestigation("inv-dup", accountId, "Workers"),
    QUESTION,
    {
      runner: new ToolRunner({ db: env.DB, investigationAccountId: accountId }),
      // No real model: the verdict must not depend on what an LLM says.
      model: new DeterministicModelClient(),
      focusService: "Workers"
    }
  );
}

/**
 * The verdict the system had never given.
 *
 * Every golden fact agrees with every other, so `abc123` can only ever show the
 * agent saying yes. This is the case where the arithmetic all ties and the
 * answer is still no. `docs/BUILD_PLAN_P1.md` Milestone 9.
 */
describe("the duplicated-usage investigation", () => {
  it("produces the pinned fact block", async () => {
    const record = await run();
    expect(record.facts).toEqual(DUPLICATE_FACTS);
  });

  it("agrees with the pure-domain computation", async () => {
    const record = await run();
    expect(record.facts).toEqual(
      goldenFacts({
        dataset: duplicate,
        currentPeriod: per("2026-08"),
        comparisonPeriod: per("2026-07"),
        focusService: "Workers"
      })
    );
  });

  it("declines to call the invoice correct, and says why", async () => {
    const record = await run();

    expect(record.state).toBe("unresolved");
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
    expect(record.facts.confidence).toBe("low");
    expect(record.blockers).toEqual(["120 duplicate usage group(s) found"]);
  });

  it("declines it *despite* every arithmetic check passing", async () => {
    // The point of the scenario, stated as an assertion. A verdict of `false`
    // here is not the easy case of something failing to add up.
    const record = await run();

    expect(record.facts.reconciliation_status).toBe("passed");
    expect(record.facts.explained_percent).toBe(100);
    expect(record.facts.price_changed).toBe(false);
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
  });

  it("checks duplicates on every metered service before claiming anything invoice-wide", async () => {
    // Invariant 23: an invoice-wide finding needs an invoice-wide check. A
    // duplicate found on Workers says nothing about Workers AI.
    const completed = record_ids(await run());
    expect(completed).toContain("check_duplicate_usage:Workers");
    expect(completed).toContain("check_duplicate_usage:Workers AI");
    expect(completed).toContain("get_price_versions:Workers");
    expect(completed).toContain("get_price_versions:Workers AI");
    expect(completed).toContain("reconcile_invoice");
  });

  it("names the duplicate in the finding, not only in the evidence", async () => {
    const record = await run();
    const shown = renderSummary(record.summary!);

    expect(record.summary!.finding).toContain("120 duplicate usage group(s)");
    expect(record.summary!.finding).toContain("cannot be confirmed as correct");
    expect(shown).toContain("Confidence: low");
    expect(shown).toContain("The investigation is unresolved");
  });

  it("never calls the duplicate the cause of the variance", async () => {
    // Invariant 8. The decomposition apportions by service, not by defect, so
    // nothing in the record supports a causal claim about the duplicate.
    const shown = renderSummary(record_summary(await run()));
    expect(shown).not.toMatch(/duplicat\w+[^.]*\b(caused|because of|due to)\b/i);
    expect(shown).not.toMatch(/\b(caused|due to)\b[^.]*duplicat/i);
  });

  it("uses only figures that appear in the record", async () => {
    // Invariant 25, applied to the deterministic summary: every money figure
    // it prints has to be one the investigation actually computed.
    const record = await run();
    const shown = renderSummary(record.summary!);
    const allowed = new Set(
      [
        record.facts.current_total_cents,
        record.facts.comparison_total_cents,
        Math.abs(record.facts.variance_cents!),
        record.facts.workers_variance_cents,
        record.facts.workers_ai_variance_cents
      ].map((c) => usd(c!))
    );
    const printed = shown.match(/\$[\d,]+\.\d{2}/g) ?? [];
    // Without this the loop below passes by matching nothing at all.
    expect(printed.length).toBeGreaterThanOrEqual(5);
    for (const amount of printed) {
      expect(allowed.has(amount), `${amount} is not in the fact block`).toBe(true);
    }
  });
});

describe("the golden account is untouched by any of it", () => {
  it("still produces its own fact block", async () => {
    const record = await run("abc123");
    expect(record.facts).toEqual(GOLDEN_FACTS);
  });

  it("still reaches completed with no blockers", async () => {
    const record = await run("abc123");
    expect(record.state).toBe("completed");
    expect(record.blockers).toEqual([]);
    expect(record.summary!.invoiceAppearsCorrect).toBe(true);
    // And its finding gains no duplicate sentence.
    expect(record.summary!.finding).not.toContain("duplicate");
  });
});

function record_ids(record: { plan: { id: string; status: string }[] }) {
  return record.plan.filter((s) => s.status === "completed").map((s) => s.id);
}
function record_summary<T extends { summary: unknown }>(record: T) {
  return record.summary as Parameters<typeof renderSummary>[0];
}
function usd(cents: number) {
  const sign = cents < 0 ? "-" : "";
  const a = Math.abs(cents);
  return `${sign}$${Math.trunc(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
}

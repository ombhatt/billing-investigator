import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";
import { goldenFacts } from "../../src/domain/invoiceVarianceCase.js";
import { ToolRunner } from "../../src/tools/registry.js";

const dataset = generateSyntheticData();
const QUESTION =
  "Why is account abc123's August invoice higher than July, and is the bill correct?";

beforeEach(async () => {
  await seedDataset(env.DB, dataset);
});

async function runGolden() {
  return await runInvestigationTurn(
    newInvestigation("inv-golden", "abc123", "Workers"),
    QUESTION,
    {
      runner: new ToolRunner({ db: env.DB, investigationAccountId: "abc123" }),
      // No real model: the golden facts must not depend on what an LLM says.
      model: new DeterministicModelClient(),
      focusService: "Workers"
    }
  );
}

/**
 * PRD §20.4 through the agent. Structured facts only — never LLM prose, which
 * is exactly the assertion the PRD asks for.
 */
describe("golden investigation through the agent", () => {
  it("produces the PRD §20.4 fact block", async () => {
    const record = await runGolden();

    expect(record.facts).toEqual({
      current_total_cents: 2_172_000,
      comparison_total_cents: 1_690_000,
      variance_cents: 482_000,
      percentage_variance_display: 28.5,
      workers_variance_cents: 464_000,
      workers_ai_variance_cents: 18_000,
      price_changed: false,
      change_date: "2026-08-14",
      correlated_event_id: "dep-1842",
      exact_duplicate_count: 0,
      probable_duplicate_count: 0,
      reconciliation_status: "passed",
      explained_percent: 100,
      volume_effect_cents: 482_000,
      price_effect_cents: 0,
      confidence: "high"
    });
  });

  it("agrees with the pure-domain computation", async () => {
    const record = await runGolden();
    const domain = goldenFacts({
      dataset,
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07",
      focusService: "Workers"
    });
    expect(record.facts).toEqual(domain);
  });

  it("reaches completed with every playbook step run", async () => {
    const record = await runGolden();

    expect(record.state).toBe("completed");
    expect(record.blockers).toEqual([]);
    // 11 now: price and duplicate checks run once per metered service.
    expect(record.plan.filter((s) => s.status === "completed")).toHaveLength(11);
    expect(record.plan.every((s) => s.status === "completed")).toBe(true);
  });

  it("carries evidence for every material claim", async () => {
    const record = await runGolden();
    const labels = record.evidence.map((e) => e.label);

    expect(labels).toContain("Invoice total change");
    expect(labels).toContain("Variance by cause");
    expect(labels).toContain("Workers price change");
    expect(labels).toContain("Workers usage change point");
    expect(labels).toContain("Duplicate usage check");
    expect(labels).toContain("Invoice reconciliation");
    expect(record.evidence.length).toBeGreaterThanOrEqual(10);
  });

  it("produces a summary that states the verified figures", async () => {
    const record = await runGolden();
    const summary = record.summary!;

    expect(summary.invoiceAppearsCorrect).toBe(true);
    expect(summary.finding).toContain("$4,820.00");
    expect(summary.finding).toContain("28.5%");
    expect(summary.evidence.join(" ")).toContain("$4,640.00");
    expect(summary.evidence.join(" ")).toContain("$180.00");
    expect(summary.assessment).toContain("appears correct");
    expect(summary.assessment).toContain("not a financial certification");
    expect(summary.recommendedNextStep).toContain("dep-1842");
  });

  it("records metrics for the turn", async () => {
    const record = await runGolden();

    expect(record.metrics.toolCalls).toBeLessThanOrEqual(12);
    expect(record.metrics.planningCycles).toBeLessThanOrEqual(4);
    expect(record.metrics.completedAt).not.toBeNull();
  });
});

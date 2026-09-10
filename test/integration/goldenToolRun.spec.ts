import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { goldenFacts } from "../../src/domain/invoiceVarianceCase.js";
import { runInvestigation } from "../../src/tools/investigationRunner.js";
import { seedDataset } from "./seedD1.js";
import type { ToolDeps } from "../../src/tools/createTool.js";

const dataset = generateSyntheticData();
const deps: ToolDeps = { db: env.DB, investigationAccountId: "abc123" };

const request = {
  accountId: "abc123",
  currentPeriod: "2026-08",
  comparisonPeriod: "2026-07",
  focusService: "Workers"
};

beforeAll(async () => {
  await seedDataset(env.DB, dataset);
});

/**
 * The Milestone 3 exit criterion: the same golden fact block the domain tests
 * prove, but produced by running the nine tools against D1. Only this catches a
 * repository that mis-maps a column or a query that quietly drops rows.
 */
describe("golden investigation through the tool layer", () => {
  it("produces the PRD §20.4 fact block from D1", async () => {
    const { facts } = await runInvestigation(deps, request);

    expect(facts).toEqual({
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

  it("agrees exactly with the pure-domain computation", async () => {
    // If the read path lost or reshaped anything, these two would diverge.
    const { facts } = await runInvestigation(deps, request);
    expect(facts).toEqual(goldenFacts({ dataset, ...request }));
  });

  it("completes all nine playbook steps in order", async () => {
    const { steps } = await runInvestigation(deps, request);

    expect(steps.map((s) => s.tool)).toEqual([
      "get_account_context",
      "compare_invoices",
      "decompose_variance",
      "get_usage_timeseries",
      "get_price_versions",
      "detect_usage_change_point",
      "get_account_events",
      "check_duplicate_usage",
      "reconcile_invoice"
    ]);
    expect(steps.every((s) => s.status === "completed")).toBe(true);
  });

  it("runs entirely without the model or the network", async () => {
    const { executions } = await runInvestigation(deps, request);
    expect(executions).toHaveLength(9);
    expect(executions.every((e) => !("error" in e.result))).toBe(true);
  });

  it("carries evidence for every material claim", async () => {
    const { evidence } = await runInvestigation(deps, request);

    const labels = evidence.map((e) => e.label);
    expect(labels).toContain("Invoice total change");
    expect(labels).toContain("Variance by cause");
    expect(labels).toContain("Workers price change");
    expect(labels).toContain("Workers usage change point");
    expect(labels).toContain("Duplicate usage check");
    expect(labels).toContain("Invoice reconciliation");

    // Zone attribution, so "which zone?" is answerable from evidence at all.
    // Note this is the split of the period's total usage, not of the increase:
    // the primary zone holds 83% of August volume while carrying ~97% of the
    // growth, and only the former is derivable from a single-period series.
    const byZone = evidence.find((e) => e.label === "Workers usage by zone")!;
    expect(byZone.value).toMatch(/zone-api-acme: [\d,]+ requests \(83%\)/);
    expect(byZone.value).toContain("zone-web-acme");

    // Every card names its tool and carries a status from the fixed vocabulary.
    for (const card of evidence) {
      expect(card.source).toBeTruthy();
      expect(["confirmed", "correlated", "not_found", "unresolved"]).toContain(
        card.status
      );
    }
  });

  it("labels the deployment as correlated, never as a cause", async () => {
    const { evidence } = await runInvestigation(deps, request);
    const deployment = evidence.find((e) => e.value.includes("dep-1842"));

    expect(deployment).toBeDefined();
    expect(deployment!.status).toBe("correlated");
    expect(
      evidence.some((e) => /caused|because of|due to/i.test(e.value))
    ).toBe(false);
  });

  it("reports no price change with the version that proves it", async () => {
    const { evidence } = await runInvestigation(deps, request);
    const price = evidence.find((e) => e.label === "Workers price change")!;

    expect(price.value).toBe("No price change found");
    expect(price.status).toBe("confirmed");
    expect(
      evidence.some((e) => e.recordIds.includes("price_versions:price-workers-2026-01"))
    ).toBe(true);
  });

  it("reuses nothing it has not already fetched", async () => {
    // Nine distinct calls, so nothing should be served from cache on a fresh run.
    const { executions } = await runInvestigation(deps, request);
    expect(executions.every((e) => !e.cached)).toBe(true);
  });
});

describe("the runner refuses to overreach", () => {
  it("cannot investigate an account outside its scope", async () => {
    await expect(
      runInvestigation(deps, { ...request, accountId: "other99" })
    ).rejects.toThrow(/ACCOUNT_SCOPE_VIOLATION/);
  });

  it("fails loudly when a required period has no invoice", async () => {
    await expect(
      runInvestigation(deps, { ...request, comparisonPeriod: "2026-01" })
    ).rejects.toThrow(/INVOICE_NOT_FOUND/);
  });
});

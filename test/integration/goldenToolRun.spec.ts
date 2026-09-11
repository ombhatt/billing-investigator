import { per } from "../support/values.js";
import { GOLDEN_FACTS } from "../support/goldenFacts.js";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { goldenFacts } from "../../src/domain/invoiceVarianceCase.js";
import { runInvestigation } from "../../src/agent/deterministicRun.js";
import { seedDataset } from "./seedD1.js";
import type { ToolDeps } from "../../src/tools/createTool.js";

const dataset = generateSyntheticData();
const deps: ToolDeps = { db: env.DB, investigationAccountId: "abc123" };

const request = {
  accountId: "abc123",
  currentPeriod: per("2026-08"),
  comparisonPeriod: per("2026-07"),
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

    expect(facts).toEqual(GOLDEN_FACTS);
  });

  it("agrees exactly with the pure-domain computation", async () => {
    // If the read path lost or reshaped anything, these two would diverge.
    const { facts } = await runInvestigation(deps, request);
    expect(facts).toEqual(goldenFacts({ dataset, ...request }));
  });

  it("runs the same playbook production runs, per metered service", async () => {
    // Eleven, not nine: pricing and duplicates run once per metered service.
    // This entry point used to have its own ordering and its own choice of
    // services, which is exactly how it drifted from production.
    const { steps } = await runInvestigation(deps, request);

    expect(steps.map((s) => s.tool)).toEqual([
      "get_account_context",
      "compare_invoices",
      "decompose_variance",
      "get_usage_timeseries",
      "get_price_versions",
      "get_price_versions",
      "detect_usage_change_point",
      "get_account_events",
      "check_duplicate_usage",
      "check_duplicate_usage",
      "reconcile_invoice"
    ]);
    expect(steps.every((s) => s.status === "completed")).toBe(true);

    // Both metered services are named, so neither check is a claim about one
    // service dressed up as a claim about the invoice.
    const labels = steps.map((s) => s.label).join(" | ");
    expect(labels).toContain("Checking contract pricing — Workers");
    expect(labels).toContain("Checking contract pricing — Workers AI");
    expect(labels).toContain("Checking for duplicate usage — Workers");
    expect(labels).toContain("Checking for duplicate usage — Workers AI");
  });

  it("runs entirely without the model or the network", async () => {
    const { executions } = await runInvestigation(deps, request);
    expect(executions).toHaveLength(12);
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

    // Two different zone questions, two different cards. The period split says
    // api holds 83% of August; the growth card says it drove 96% of the rise.
    const byZone = evidence.find((e) => e.label === "Workers usage by zone")!;
    expect(byZone.value).toMatch(/zone-api-acme: [\d,]+ requests \(83%\)/);
    expect(byZone.value).toContain("zone-web-acme");

    const growth = evidence.find((e) => e.label === "Workers growth by zone")!;
    expect(growth.value).toContain("% of the increase");

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

  it("serves a repeat call from cache rather than re-reading D1", async () => {
    // The account context is fetched to validate the periods, then again as the
    // first playbook step. Exactly one execution should be a cache hit — more
    // would mean redundant work, none would mean the cache is not wired in.
    const { executions } = await runInvestigation(deps, request);
    const cached = executions.filter((e) => e.cached);

    expect(cached).toHaveLength(1);
    expect(cached[0].tool).toBe("get_account_context");
  });
});

describe("the runner refuses to overreach", () => {
  it("cannot investigate an account outside its scope", async () => {
    await expect(
      runInvestigation(deps, { ...request, accountId: "other99" })
    ).rejects.toThrow(/ACCOUNT_SCOPE_VIOLATION/);
  });

  it("fails loudly when a required period has no invoice", async () => {
    // It now declines before spending a call rather than failing on the lookup,
    // and names the period it does not have.
    await expect(
      runInvestigation(deps, { ...request, comparisonPeriod: per("2026-01") })
    ).rejects.toThrow(/did not start.*2026-01/);
  });
});

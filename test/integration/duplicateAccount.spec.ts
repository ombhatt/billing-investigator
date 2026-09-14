import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import {
  DUPLICATE_USAGE_ACCOUNT,
  GOLDEN_ACCOUNT
} from "../../seed/constants.js";
import { seedDataset } from "./seedD1.js";
import { ToolRunner } from "../../src/tools/registry.js";
import type { ToolDeps } from "../../src/tools/createTool.js";
import { isFailure } from "../../src/types/tools.js";

/**
 * The first seeded account whose honest verdict is "not correct".
 *
 * An ingestion replay billed one run of traffic twice. The rollup summed both
 * copies, rating priced what the rollup said, and the invoice states that total
 * faithfully — so **every reconciliation boundary ties and the bill is still
 * overstated**. That combination is the point: it is what shows why PRD rule 7
 * has three clauses rather than one, and it is the thing `abc123` can never
 * demonstrate, because there every answer agrees.
 *
 * Proven here through the real tools against D1, with no agent and no model.
 * `docs/BUILD_PLAN_P1.md` Milestone 7.
 */

const ACCOUNT = "dup-7741";
const golden = generateSyntheticData(GOLDEN_ACCOUNT);
const duplicate = generateSyntheticData(DUPLICATE_USAGE_ACCOUNT);

const deps: ToolDeps = { db: env.DB, investigationAccountId: ACCOUNT };
const runner = new ToolRunner(deps);

beforeAll(async () => {
  // Both accounts, so the checks below also prove they do not contaminate
  // each other inside one database.
  await seedDataset(env.DB, golden, duplicate);
});

async function unwrap<T>(result: Promise<{ data?: T } | unknown>) {
  const r = (await result) as { data?: T } & Record<string, unknown>;
  if (isFailure(r as never)) throw new Error(JSON.stringify(r));
  return r.data as T;
}

describe("the duplicated-usage account", () => {
  it("finds probable duplicates and no exact ones", async () => {
    // Exact duplicates are unstorable: usage_events.event_id is the primary
    // key, so a repeated id cannot exist. A replay assigns fresh ids to the
    // same source records, which is a *probable* duplicate by fingerprint.
    const data = await unwrap<{
      exactCount: number;
      probableCount: number;
      probableQuantity: number;
      probableCostCents: number;
    }>(
      runner.run("check_duplicate_usage", {
        accountId: ACCOUNT,
        serviceName: "Workers",
        startDate: "2026-08-01",
        endDate: "2026-08-31"
      })
    );

    expect(data.exactCount).toBe(0);
    expect(data.probableCount).toBeGreaterThanOrEqual(1);
  });

  it("counts only the surplus copies, never the whole group", async () => {
    const data = await unwrap<{
      probableCount: number;
      probableQuantity: number;
    }>(
      runner.run("check_duplicate_usage", {
        accountId: ACCOUNT,
        serviceName: "Workers",
        startDate: "2026-08-01",
        endDate: "2026-08-31"
      })
    );

    // Each replayed slot appears twice; the first occurrence is legitimate.
    // Counting the group would double the surplus and overstate the finding.
    const replayed = duplicate.usageEvents.filter((e) =>
      e.eventId.startsWith("replay-")
    );
    const surplus = replayed.reduce((sum, e) => sum + e.quantity, 0);

    expect(data.probableCount).toBe(replayed.length);
    expect(data.probableQuantity).toBe(surplus);
  });

  it("prices the surplus at the overage rate, materially", async () => {
    const data = await unwrap<{ probableCostCents: number }>(
      runner.run("check_duplicate_usage", {
        accountId: ACCOUNT,
        serviceName: "Workers",
        startDate: "2026-08-01",
        endDate: "2026-08-31"
      })
    );

    const august = duplicate.invoices.find((i) => i.period === "2026-08")!;
    const july = duplicate.invoices.find((i) => i.period === "2026-07")!;
    const variance = august.totalCents - july.totalCents;

    expect(data.probableCostCents).toBeGreaterThan(0);
    // The replay is the majority of why the bill moved — that is the finding.
    expect(data.probableCostCents / variance).toBeGreaterThan(0.5);
    // And it is visible against the invoice, not a rounding artefact.
    expect(data.probableCostCents / august.totalCents).toBeGreaterThan(0.05);
  });

  it("reconciles at every boundary even though the bill is overstated", async () => {
    // The whole scenario turns on this passing. A duplicate stopped before the
    // rollup would fail raw_usage_vs_daily_aggregate and make this a pipeline
    // -discrepancy case instead, which proves something else entirely.
    const data = await unwrap<{
      status: string;
      checkpoints: { boundary: string; passed: boolean; difference: number }[];
    }>(
      runner.run("reconcile_invoice", { accountId: ACCOUNT, period: "2026-08" })
    );

    expect(data.status).toBe("passed");
    expect(data.checkpoints.filter((c) => !c.passed)).toEqual([]);
    expect(new Set(data.checkpoints.map((c) => c.boundary)).size).toBe(12);
    expect(
      data.checkpoints.some((c) => c.boundary === "raw_usage_vs_daily_aggregate")
    ).toBe(true);
  });

  it("carries the replay through the rollup into the invoice", async () => {
    // Lineage has to agree with the rollup, or a different boundary fails and
    // the scenario becomes an accident rather than a design.
    const replayedDate = "2026-08-04";
    const row = duplicate.dailyUsage.find(
      (r) =>
        r.serviceName === "Workers" &&
        r.zoneId === DUPLICATE_USAGE_ACCOUNT.account.primaryZoneId &&
        r.usageDate === replayedDate
    )!;
    const events = duplicate.usageEvents.filter(
      (e) =>
        e.serviceName === "Workers" &&
        e.zoneId === DUPLICATE_USAGE_ACCOUNT.account.primaryZoneId &&
        e.occurredAt.startsWith(replayedDate)
    );

    expect(row.sourceEventCount).toBe(events.length);
    expect(row.quantity).toBe(events.reduce((s, e) => s + e.quantity, 0));
    // 24 hourly slots, each replayed once.
    expect(events.length).toBe(48);
  });

  it("reports no price change, so the duplicate is the only anomaly", async () => {
    const data = await unwrap<{ priceChanged: boolean }>(
      runner.run("get_price_versions", {
        accountId: ACCOUNT,
        serviceName: "Workers",
        startDate: "2026-07-01",
        endDate: "2026-08-31"
      })
    );
    expect(data.priceChanged).toBe(false);
  });
});

describe("the golden account is unaffected", () => {
  const goldenDeps: ToolDeps = { db: env.DB, investigationAccountId: "abc123" };
  const goldenRunner = new ToolRunner(goldenDeps);

  it("still finds no duplicates with both accounts in one database", async () => {
    for (const serviceName of ["Workers", "Workers AI"]) {
      const data = await unwrap<{
        exactCount: number;
        probableCount: number;
      }>(
        goldenRunner.run("check_duplicate_usage", {
          accountId: "abc123",
          serviceName,
          startDate: "2026-08-01",
          endDate: "2026-08-31"
        })
      );
      expect(data.exactCount).toBe(0);
      expect(data.probableCount).toBe(0);
    }
  });

  it("still reports its own invoice totals", async () => {
    const data = await unwrap<{
      currentTotalCents: number;
      comparisonTotalCents: number;
      varianceCents: number;
    }>(
      goldenRunner.run("compare_invoices", {
        accountId: "abc123",
        currentPeriod: "2026-08",
        comparisonPeriod: "2026-07"
      })
    );
    expect(data.currentTotalCents).toBe(2172000);
    expect(data.comparisonTotalCents).toBe(1690000);
    expect(data.varianceCents).toBe(482000);
  });

  it("denies a tool call that reaches for the other account", async () => {
    const result = await runner.run("compare_invoices", {
      accountId: "abc123",
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07"
    });
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error.code).toBe("ACCOUNT_SCOPE_VIOLATION");
    }
  });
});

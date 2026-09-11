import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import {
  InMemoryInvestigationStore,
  type InvestigationStore
} from "../../src/agent/investigationStore.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";
import { ToolRunner } from "../../src/tools/registry.js";
import type { InvestigationRecord } from "../../src/agent/types.js";

const dataset = generateSyntheticData();
const ACCOUNT = "abc123";
const QUESTION =
  "Why is account abc123's 2026-08 invoice different from 2026-07, and is the bill correct?";

/**
 * Evidence has to outlive the isolate that produced it.
 *
 * The agent wrote an audit row per tool call — name, timing, error code — and
 * dropped the envelope, so the evidence cards and data limitations behind every
 * claim existed only in memory. The cache was a `Map` that died with the turn,
 * so FR-5's "cached *persisted* result within the investigation" reached D1
 * twice for the same question.
 */

beforeEach(async () => {
  await seedDataset(env.DB, dataset);
});

/** One turn, against a store the test can inspect and outlive. */
async function investigate(
  store: InvestigationStore,
  record: InvestigationRecord
) {
  const runner = new ToolRunner(
    { db: env.DB, investigationAccountId: ACCOUNT },
    { store, investigationId: record.investigationId }
  );
  const next = await runInvestigationTurn(record, QUESTION, {
    runner,
    model: new DeterministicModelClient(),
    focusService: "Workers"
  });
  await store.record(next.investigationId, runner.executions);
  return { record: next, runner };
}

describe("evidence survives the runtime that produced it", () => {
  it("keeps the whole envelope, not just that a call happened", async () => {
    const store = new InMemoryInvestigationStore();
    const opened = newInvestigation("inv-store", ACCOUNT, "Workers");
    const { record } = await investigate(store, opened);
    await store.commit(record, 0);

    const kept = await store.envelopes("inv-store");
    expect(kept.length).toBeGreaterThanOrEqual(11);

    // The things the audit table dropped.
    const reconcile = kept.find((e) => e.tool === "reconcile_invoice")!;
    const envelope = reconcile.result as {
      evidence: { label: string }[];
      dataLimitations: string[];
      data: { status: string };
      sourceRecordIds: string[];
    };
    expect(envelope.data.status).toBe("passed");
    expect(envelope.evidence.length).toBeGreaterThan(0);
    expect(Array.isArray(envelope.dataLimitations)).toBe(true);
    expect(Array.isArray(envelope.sourceRecordIds)).toBe(true);

    // And a limitation that a real tool actually emits.
    const withLimits = kept.flatMap(
      (e) => (e.result as { dataLimitations?: string[] }).dataLimitations ?? []
    );
    expect(withLimits.join(" ")).toMatch(/describes when usage moved, not why/);
  });

  it("recovers the complete evidence after the runtime is recreated", async () => {
    // The store is the only thing that crosses: new runner, new record object,
    // nothing carried in memory.
    const store = new InMemoryInvestigationStore();
    const { record } = await investigate(
      store,
      newInvestigation("inv-recover", ACCOUNT, "Workers")
    );
    await store.commit(record, 0);

    const recovered = await store.envelopes("inv-recover");
    const evidence = recovered.flatMap(
      (e) => (e.result as { evidence?: { label: string }[] }).evidence ?? []
    );
    const labels = evidence.map((c) => c.label);

    expect(labels).toContain("Invoice total change");
    expect(labels).toContain("Variance by cause");
    expect(labels).toContain("Invoice reconciliation");
    expect(labels).toContain("Workers growth by zone");
    // Every card recovered intact, not just its name.
    expect(evidence.every((c) => typeof c.label === "string" && c.label !== "")).toBe(
      true
    );
  });

  it("reuses a persisted result rather than reading D1 again", async () => {
    const store = new InMemoryInvestigationStore();
    const opened = newInvestigation("inv-reuse", ACCOUNT, "Workers");
    await investigate(store, opened);

    // A second turn with a fresh runner: the in-memory cache is gone, so a
    // reused result can only have come from the store.
    const second = new ToolRunner(
      { db: env.DB, investigationAccountId: ACCOUNT },
      { store, investigationId: "inv-reuse" }
    );
    const result = await second.run("reconcile_invoice", {
      accountId: ACCOUNT,
      period: "2026-08"
    });

    expect("error" in result).toBe(false);
    expect(second.executions).toHaveLength(1);
    expect(second.executions[0].cached).toBe(true);
    expect((result as { data: { status: string } }).data.status).toBe("passed");
  });

  it("never reuses a failure", async () => {
    // A transient error must stay retryable rather than becoming sticky.
    const store = new InMemoryInvestigationStore();
    const runner = new ToolRunner(
      { db: env.DB, investigationAccountId: ACCOUNT },
      { store, investigationId: "inv-fail" }
    );
    await runner.run("reconcile_invoice", { accountId: ACCOUNT, period: "2026-01" });
    await store.record("inv-fail", runner.executions);

    expect(await store.reusable("inv-fail", runner.executions[0].cacheKey)).toBeNull();
  });

  it("keeps one investigation's evidence out of another's", async () => {
    const store = new InMemoryInvestigationStore();
    await investigate(store, newInvestigation("inv-a", ACCOUNT, "Workers"));

    expect((await store.envelopes("inv-a")).length).toBeGreaterThan(0);
    expect(await store.envelopes("inv-b")).toEqual([]);
  });
});

describe("a reset still prevents a stale commit", () => {
  it("refuses a record from a turn that opened before the reset", async () => {
    const store = new InMemoryInvestigationStore();
    const openedIn = await store.generation();
    const { record } = await investigate(
      store,
      newInvestigation("inv-stale", ACCOUNT, "Workers")
    );

    // The reader presses Reset while the turn is still running.
    store.reset();

    expect(await store.commit(record, openedIn)).toBe(false);
    expect(store.state.investigation).toBeNull();
    expect(store.state.generation).toBe(1);
  });

  it("accepts a turn opened after the reset", async () => {
    // The control: the generation check blocks stale work, not all work.
    const store = new InMemoryInvestigationStore();
    store.reset();
    const openedIn = await store.generation();
    const { record } = await investigate(
      store,
      newInvestigation("inv-fresh", ACCOUNT, "Workers")
    );

    expect(await store.commit(record, openedIn)).toBe(true);
    expect(store.state.investigation).not.toBeNull();
  });

  it("keeps the envelopes of a turn whose record was refused", async () => {
    // The calls genuinely happened, and the audit trail says so. It is the
    // conclusion that must not come back from the dead.
    const store = new InMemoryInvestigationStore();
    const openedIn = await store.generation();
    const { record } = await investigate(
      store,
      newInvestigation("inv-audit", ACCOUNT, "Workers")
    );
    store.reset();
    await store.commit(record, openedIn);

    expect((await store.envelopes("inv-audit")).length).toBeGreaterThan(0);
    expect(store.state.investigation).toBeNull();
  });
});

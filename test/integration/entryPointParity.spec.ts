import { day, per } from "../support/values.js";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import { goldenFacts } from "../../src/domain/invoiceVarianceCase.js";
import { runInvestigation } from "../../src/agent/deterministicRun.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";
import { ToolRunner } from "../../src/tools/registry.js";
import type { BillingDataset } from "../../src/domain/types.js";

/**
 * Three ways in, one investigation policy.
 *
 * The production loop learned to run pricing and duplicate checks once per
 * metered service, because an invoice-wide claim needs an invoice-wide check.
 * The deterministic runner and the pure-domain analysis kept checking the focus
 * service alone. Both agreed with production on the golden fixture — nothing in
 * it is repriced or duplicated — and disagreed the moment a non-driver service
 * moved.
 *
 * A fixture that agrees is not the same as an implementation that agrees. These
 * scenarios are built specifically to make the old divergence visible: each one
 * puts the interesting event on **Workers AI**, which is never the driver.
 */

const ACCOUNT = "abc123";
const request = {
  accountId: ACCOUNT,
  currentPeriod: per("2026-08"),
  comparisonPeriod: per("2026-07"),
  focusService: "Workers"
};

/** Splits a service's price mid-window: a repricing, on a non-driver service. */
function repriced(dataset: BillingDataset, service: string): BillingDataset {
  return {
    ...dataset,
    priceVersions: dataset.priceVersions.flatMap((p) =>
      p.serviceName === service
        ? [
            { ...p, effectiveTo: day("2026-07-31") },
            {
              ...p,
              priceVersionId: `${p.priceVersionId}-b`,
              effectiveFrom: day("2026-08-01"),
              effectiveTo: null
            }
          ]
        : [p]
    )
  };
}

/**
 * Copies one usage event on a non-driver service.
 *
 * This is a *probable* duplicate, not an exact one: exact means a repeated
 * `event_id`, which the primary key makes unstorable. The copy carries a new id
 * and an identical fingerprint — same account, service, zone, source key,
 * minute bucket, quantity and unit — which is what a genuine double-ingest
 * looks like.
 */
function duplicated(dataset: BillingDataset, service: string): BillingDataset {
  const original = dataset.usageEvents.find(
    (e) => e.serviceName === service && e.occurredAt.startsWith("2026-08")
  );
  if (!original) throw new Error(`no ${service} usage in 2026-08 to duplicate`);
  return {
    ...dataset,
    usageEvents: [
      ...dataset.usageEvents,
      { ...original, eventId: `${original.eventId}-copy` }
    ]
  };
}

/** The production path, with no model rather than no playbook. */
async function throughAgent(db: D1Database) {
  const record = await runInvestigationTurn(
    newInvestigation("parity", ACCOUNT, "Workers"),
    "Why is account abc123's 2026-08 invoice different from 2026-07, and is the bill correct?",
    {
      runner: new ToolRunner({ db, investigationAccountId: ACCOUNT }),
      model: new DeterministicModelClient(),
      focusService: "Workers"
    }
  );
  return record.facts;
}

async function throughRunner(db: D1Database) {
  const { facts } = await runInvestigation(
    { db, investigationAccountId: ACCOUNT },
    request
  );
  return facts;
}

describe("every entry point reports the same investigation", () => {
  describe("the golden case", () => {
    const dataset = generateSyntheticData();
    beforeEach(async () => {
      await seedDataset(env.DB, dataset);
    });

    it("agrees across agent, runner and pure domain", async () => {
      const [agent, runner] = await Promise.all([
        throughAgent(env.DB),
        throughRunner(env.DB)
      ]);
      const domain = goldenFacts({ dataset, ...request });

      expect(runner).toEqual(agent);
      expect(domain).toEqual(agent);
    });
  });

  describe("a repricing on a service that is not the driver", () => {
    const dataset = repriced(generateSyntheticData(), "Workers AI");
    beforeEach(async () => {
      await seedDataset(env.DB, dataset);
    });

    it("is reported by all three, not just production", async () => {
      const agent = await throughAgent(env.DB);
      const runner = await throughRunner(env.DB);
      const domain = goldenFacts({ dataset, ...request });

      // The heart of it: this was false in the domain and runner paths while
      // production reported true.
      expect(agent.price_changed).toBe(true);
      expect(runner.price_changed).toBe(true);
      expect(domain.price_changed).toBe(true);
    });

    it("still agrees on every other fact", async () => {
      const agent = await throughAgent(env.DB);
      const runner = await throughRunner(env.DB);
      expect(runner).toEqual(agent);
      expect(goldenFacts({ dataset, ...request })).toEqual(agent);
    });
  });

  describe("a duplicate on a service that is not the driver", () => {
    const dataset = duplicated(generateSyntheticData(), "Workers AI");
    beforeEach(async () => {
      await seedDataset(env.DB, dataset);
    });

    it("is counted by all three", async () => {
      const agent = await throughAgent(env.DB);
      const runner = await throughRunner(env.DB);
      const domain = goldenFacts({ dataset, ...request });

      expect(agent.probable_duplicate_count).toBeGreaterThan(0);
      expect(runner.probable_duplicate_count).toBe(agent.probable_duplicate_count);
      expect(domain.probable_duplicate_count).toBe(agent.probable_duplicate_count);
    });
  });

  describe("service selection", () => {
    const dataset = generateSyntheticData();
    beforeEach(async () => {
      await seedDataset(env.DB, dataset);
    });

    it("checks both metered services, and only the metered ones", async () => {
      const runner = new ToolRunner({ db: env.DB, investigationAccountId: ACCOUNT });
      await runInvestigationTurn(
        newInvestigation("parity-services", ACCOUNT, "Workers"),
        "Why is account abc123's 2026-08 invoice different from 2026-07, and is the bill correct?",
        { runner, model: new DeterministicModelClient(), focusService: "Workers" }
      );

      const priceChecks = runner.executions
        .filter((e) => e.tool === "get_price_versions")
        .map((e) => (e.input as { serviceName: string }).serviceName)
        .sort();

      expect(priceChecks).toEqual(["Workers", "Workers AI"]);
      // R2 and D1 are fixed-fee lines in this dataset: no usage pipeline, so a
      // price or duplicate check against them would be meaningless.
      expect(priceChecks).not.toContain("R2");
      expect(priceChecks).not.toContain("D1");
    });
  });
});

import { c, q } from "./../support/values.js";
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import { newInvestigation, runInvestigationTurn } from "../../src/agent/loop.js";
import { DeterministicModelClient } from "../../src/agent/modelClient.js";
import { rateUsage } from "../../src/domain/rating.js";
import { ToolRunner } from "../../src/tools/registry.js";

/**
 * Diagnostic scope used to be hard-coded to Workers while the answer made
 * invoice-wide claims. Review demonstrated both halves of the resulting lie:
 * a Workers AI duplicate reported as "no duplicate usage was found", and a
 * tripled Workers AI rate reported as "contract pricing did not change".
 *
 * An assertion about the invoice has to be backed by a check of the invoice.
 */

const dataset = generateSyntheticData();

async function investigate() {
  return runInvestigationTurn(
    // Focus is deliberately seeded to the wrong service to prove it is derived,
    // not trusted.
    newInvestigation("scope", "abc123", "R2"),
    "Why is the August invoice higher, and is the bill correct?",
    {
      runner: new ToolRunner({ db: env.DB, investigationAccountId: "abc123" }),
      model: new DeterministicModelClient(),
      focusService: "R2"
    }
  );
}

beforeEach(async () => {
  await seedDataset(env.DB, dataset);
});

describe("diagnostics cover every metered service", () => {
  it("checks pricing for both Workers and Workers AI", async () => {
    const record = await investigate();
    const priced = record.plan
      .filter((s) => s.tool === "get_price_versions" && s.status === "completed")
      .map((s) => s.service);
    expect(priced.sort()).toEqual(["Workers", "Workers AI"]);
  });

  it("checks duplicates for both Workers and Workers AI", async () => {
    const record = await investigate();
    const checked = record.plan
      .filter((s) => s.tool === "check_duplicate_usage" && s.status === "completed")
      .map((s) => s.service);
    expect(checked.sort()).toEqual(["Workers", "Workers AI"]);
  });

  it("derives the investigative focus from the largest driver", async () => {
    // Seeded as "R2", a fixed-fee line with no usage at all.
    const record = await investigate();
    expect(record.focusService).toBe("Workers");
  });

  it("does not treat fixed-fee lines as metered", async () => {
    const record = await investigate();
    const services = record.plan
      .filter((s) => s.service !== undefined)
      .map((s) => s.service);
    expect(services).not.toContain("Platform fee");
    expect(services).not.toContain("R2");
    expect(services).not.toContain("D1");
  });

  it("still reaches the golden conclusion", async () => {
    const record = await investigate();
    expect(record.state).toBe("completed");
    expect(record.facts.variance_cents).toBe(482_000);
    expect(record.facts.confidence).toBe("high");
    expect(record.metrics.toolCalls).toBeLessThanOrEqual(12);
  });
});

describe("a Workers AI duplicate is not reported as no duplicates", () => {
  beforeEach(async () => {
    // Propagated consistently through every billing stage, so reconciliation
    // still passes and only the duplicate check can catch it.
    const source = dataset.usageEvents.find(
      (e) => e.serviceName === "Workers AI" && e.occurredAt.startsWith("2026-08")
    )!;
    const price = dataset.priceVersions.find(
      (p) => p.serviceName === "Workers AI"
    )!;

    await env.DB.prepare(
      `INSERT INTO usage_events (event_id, account_id, service_name, zone_id,
        source_event_key, occurred_at, quantity, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        `${source.eventId}-dup`,
        source.accountId,
        source.serviceName,
        source.zoneId,
        source.sourceEventKey,
        source.occurredAt,
        source.quantity,
        source.unit
      )
      .run();

    const day = source.occurredAt.slice(0, 10);
    await env.DB.prepare(
      `UPDATE daily_usage SET quantity = quantity + ?, source_event_count = source_event_count + 1
        WHERE service_name = 'Workers AI' AND usage_date = ?`
    )
      .bind(source.quantity, day)
      .run();

    const consumed = q(6_600_000 + source.quantity);
    const amount = rateUsage(consumed, price).amountCents;
    const delta = amount - 33_000;

    await env.DB.prepare(
      `UPDATE rated_charges SET consumed_quantity = ?, billable_quantity = ?, amount_cents = ?
        WHERE service_name = 'Workers AI' AND period = '2026-08'`
    )
      .bind(consumed, consumed, amount)
      .run();
    await env.DB.prepare(
      `UPDATE invoice_lines SET quantity = ?, amount_cents = ?
        WHERE service_name = 'Workers AI' AND invoice_id = 'inv-abc123-2026-08'`
    )
      .bind(consumed, amount)
      .run();
    await env.DB.prepare(
      `UPDATE invoices SET subtotal_cents = subtotal_cents + ?, total_cents = total_cents + ?
        WHERE period = '2026-08'`
    )
      .bind(delta, delta)
      .run();
  });

  it("finds the duplicate", async () => {
    const record = await investigate();
    expect(record.facts.probable_duplicate_count).toBeGreaterThan(0);
  });

  it("refuses to call the invoice correct", async () => {
    const record = await investigate();
    expect(record.state).toBe("unresolved");
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
    expect(record.facts.confidence).toBe("low");
  });

  it("does not claim no duplicates were found", async () => {
    const record = await investigate();
    const text = record.summary!.evidence.join(" ");
    expect(text).not.toMatch(/No exact or probable duplicate usage was found/i);
  });
});

describe("an unauthorised fixed fee is not reported as correct", () => {
  beforeEach(async () => {
    // The invoice charges $100 more than the subscription authorises. Every
    // sum stays internally consistent, so only a check against the
    // subscription can catch it.
    await env.DB.prepare(
      `UPDATE invoice_lines SET amount_cents = amount_cents + 10000
        WHERE service_name = 'Platform fee' AND invoice_id = 'inv-abc123-2026-08'`
    ).run();
    await env.DB.prepare(
      `UPDATE invoices SET subtotal_cents = subtotal_cents + 10000,
              total_cents = total_cents + 10000 WHERE period = '2026-08'`
    ).run();
  });

  it("fails reconciliation", async () => {
    const record = await investigate();
    expect(record.facts.reconciliation_status).toBe("failed");
  });

  it("refuses to call the invoice correct", async () => {
    // Review reproduced this as completed / 100% explained / high confidence.
    const record = await investigate();
    expect(record.state).toBe("unresolved");
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
    expect(record.facts.confidence).not.toBe("high");
  });

  it("does not let 'explained' stand in for 'valid'", async () => {
    const record = await investigate();
    // The variance is still fully attributed — that was never the problem.
    expect(record.facts.explained_percent).toBe(100);
    // But attribution is not authorisation.
    expect(record.summary!.invoiceAppearsCorrect).toBe(false);
  });
});

describe("a Workers AI reprice is not reported as unchanged pricing", () => {
  beforeEach(async () => {
    const old = dataset.priceVersions.find(
      (p) => p.serviceName === "Workers AI"
    )!;
    const newRate = c(15_000); // $150 per million, up from $50

    await env.DB.prepare(
      "UPDATE price_versions SET effective_to = '2026-07-31' WHERE price_version_id = ?"
    )
      .bind(old.priceVersionId)
      .run();
    await env.DB.prepare(
      `INSERT INTO price_versions (price_version_id, account_id, service_name,
        service_family, included_quantity, overage_rate_cents, unit_divisor, unit,
        fixed_fee_cents, effective_from, effective_to)
       VALUES ('price-workers-ai-2026-08', 'abc123', 'Workers AI', 'Workers AI',
        0, ?, 1000000, 'units', 0, '2026-08-01', NULL)`
    )
      .bind(newRate)
      .run();

    const amount = rateUsage(q(6_600_000), {
      ...old,
      overageRateCents: newRate
    }).amountCents;
    const delta = amount - 33_000;

    await env.DB.prepare(
      `UPDATE rated_charges SET price_version_id = 'price-workers-ai-2026-08', amount_cents = ?
        WHERE service_name = 'Workers AI' AND period = '2026-08'`
    )
      .bind(amount)
      .run();
    await env.DB.prepare(
      `UPDATE invoice_lines SET amount_cents = ?
        WHERE service_name = 'Workers AI' AND invoice_id = 'inv-abc123-2026-08'`
    )
      .bind(amount)
      .run();
    await env.DB.prepare(
      `UPDATE invoices SET subtotal_cents = subtotal_cents + ?, total_cents = total_cents + ?
        WHERE period = '2026-08'`
    )
      .bind(delta, delta)
      .run();
  });

  it("reports that pricing changed", async () => {
    const record = await investigate();
    expect(record.facts.price_changed).toBe(true);
  });

  it("does not claim contract pricing was unchanged", async () => {
    const record = await investigate();
    const text = record.summary!.evidence.join(" ");
    expect(text).not.toMatch(/pricing did not change/i);
    expect(text).toMatch(/pricing changed/i);
  });

  it("attributes part of the variance to price, not only volume", async () => {
    const record = await investigate();
    expect(record.facts.price_effect_cents).not.toBe(0);
  });
});

import { per } from "./../support/values.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import {
  ACCOUNT_PROFILES,
  GOLDEN_ACCOUNT,
  type AccountProfile
} from "../../seed/constants.js";
import { emitSql } from "../../seed/emitSql.js";
import { consumedInPeriod } from "../../src/domain/invoice.js";
import { toBillableUsageRecords } from "../../src/domain/billableUsageView.js";

const dataset = generateSyntheticData();

describe("seed reproducibility", () => {
  it("produces byte-identical SQL across runs", () => {
    expect(emitSql(generateSyntheticData())).toBe(
      emitSql(generateSyntheticData())
    );
  });

  it("produces different data for a different seed", () => {
    expect(
      emitSql(generateSyntheticData({ ...GOLDEN_ACCOUNT, seed: 1 }))
    ).not.toBe(emitSql(dataset));
  });

  it("stores no prewritten conclusion anywhere in the data", () => {
    const sql = emitSql(dataset).toLowerCase();
    for (const forbidden of ["4,820", "4820.00", "28.5%", "edge-router-v3 caused"]) {
      expect(sql).not.toContain(forbidden);
    }
  });
});

describe("monthly totals are exact", () => {
  it("hits the July and August Workers targets to the request", () => {
    expect(consumedInPeriod(dataset.dailyUsage, "Workers", per("2026-07"))).toBe(
      1_000_000_000
    );
    expect(consumedInPeriod(dataset.dailyUsage, "Workers", per("2026-08"))).toBe(
      1_580_000_000
    );
  });

  it("hits the Workers AI targets", () => {
    expect(consumedInPeriod(dataset.dailyUsage, "Workers AI", per("2026-07"))).toBe(
      3_000_000
    );
    expect(consumedInPeriod(dataset.dailyUsage, "Workers AI", per("2026-08"))).toBe(
      6_600_000
    );
  });

  it("seeds June for historical context", () => {
    expect(consumedInPeriod(dataset.dailyUsage, "Workers", per("2026-06"))).toBe(
      980_000_000
    );
  });

  it("produces the golden invoice totals", () => {
    const byPeriod = new Map(dataset.invoices.map((i) => [i.period, i.totalCents]));
    expect(byPeriod.get(per("2026-07"))).toBe(1_690_000);
    expect(byPeriod.get(per("2026-08"))).toBe(2_172_000);
  });

  it("matches the PRD line-item table", () => {
    const august = dataset.invoices.find((i) => i.period === "2026-08")!;
    const lines = new Map(
      dataset.invoiceLines
        .filter((l) => l.invoiceId === august.invoiceId)
        .map((l) => [l.serviceName, l.amountCents])
    );
    expect(lines.get("Platform fee")).toBe(600_000);
    expect(lines.get("Workers")).toBe(1_184_000);
    expect(lines.get("Workers AI")).toBe(33_000);
    expect(lines.get("R2")).toBe(250_000);
    expect(lines.get("D1")).toBe(105_000);
  });
});

describe("usage shape", () => {
  function dailyTotals(period: string) {
    const byDate = new Map<string, number>();
    for (const row of dataset.dailyUsage) {
      if (row.serviceName !== "Workers") continue;
      if (!row.usageDate.startsWith(period)) continue;
      byDate.set(row.usageDate, (byDate.get(row.usageDate) ?? 0) + row.quantity);
    }
    return byDate;
  }

  it("keeps every daily quantity positive", () => {
    expect(dataset.dailyUsage.every((r) => r.quantity > 0)).toBe(true);
    expect(dataset.usageEvents.every((e) => e.quantity > 0)).toBe(true);
  });

  it("has August 1-13 resembling the July baseline", () => {
    const july = [...dailyTotals("2026-07").values()];
    const julyMean = july.reduce((a, b) => a + b, 0) / july.length;

    const august = dailyTotals("2026-08");
    const preChange = [...august.entries()]
      .filter(([date]) => date < "2026-08-14")
      .map(([, q]) => q);
    const preMean = preChange.reduce((a, b) => a + b, 0) / preChange.length;

    expect(Math.abs(preMean - julyMean) / julyMean).toBeLessThan(0.05);
  });

  it("rises materially from August 14", () => {
    const august = dailyTotals("2026-08");
    const before = august.get("2026-08-13")!;
    const after = august.get("2026-08-20")!;
    expect(after / before).toBeGreaterThan(1.5);
  });

  it("shows a weekday/weekend rhythm", () => {
    const july = dailyTotals("2026-07");
    // 2026-07-04 is a Saturday, 2026-07-07 a Tuesday.
    expect(july.get("2026-07-04")!).toBeLessThan(july.get("2026-07-07")!);
  });

  it("sends most of the increase to the primary zone", () => {
    const growth = (zoneId: string) => {
      const sum = (period: string) =>
        dataset.dailyUsage
          .filter(
            (r) =>
              r.serviceName === "Workers" &&
              r.zoneId === zoneId &&
              r.usageDate.startsWith(period)
          )
          .reduce((total, r) => total + r.quantity, 0);
      return sum("2026-08") - sum("2026-07");
    };
    const api = growth("zone-api-acme");
    const web = growth("zone-web-acme");
    expect(api / (api + web)).toBeGreaterThan(0.9);
  });

  it("starts the August 14 shift at 10:20 UTC", () => {
    const onDay = dataset.usageEvents
      .filter(
        (e) =>
          e.serviceName === "Workers" &&
          e.zoneId === "zone-api-acme" &&
          e.occurredAt.startsWith("2026-08-14")
      )
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

    const beforeShift = onDay.filter((e) => e.occurredAt < "2026-08-14T10:20:00Z");
    const fromShift = onDay.filter((e) => e.occurredAt >= "2026-08-14T10:20:00Z");
    expect(fromShift[0].occurredAt).toBe("2026-08-14T10:20:00Z");

    // Compare like with like: the 09:20 and 10:20 buckets are adjacent points
    // on the diurnal curve, so the jump between them is the regime change.
    const nine = beforeShift.find((e) => e.occurredAt.endsWith("09:20:00Z"))!;
    const ten = fromShift.find((e) => e.occurredAt.endsWith("10:20:00Z"))!;
    expect(ten.quantity / nine.quantity).toBeGreaterThan(2);
  });
});

describe("negative facts required by the golden scenario", () => {
  it("has no credits or tax on either invoice", () => {
    for (const invoice of dataset.invoices) {
      expect(invoice.creditCents).toBe(0);
      expect(invoice.taxCents).toBe(0);
    }
  });

  it("has exactly one price version per service", () => {
    expect(dataset.priceVersions.filter((p) => p.serviceName === "Workers")).toHaveLength(1);
    expect(
      dataset.priceVersions.filter((p) => p.serviceName === "Workers AI")
    ).toHaveLength(1);
  });

  it("has no subscription change during the comparison window", () => {
    const changes = dataset.accountEvents.filter(
      (e) =>
        (e.eventType === "subscription_change" ||
          e.eventType === "entitlement_change") &&
        e.occurredAt >= "2026-07-01" &&
        e.occurredAt <= "2026-08-31T23:59:59Z"
    );
    expect(changes).toEqual([]);
  });

  it("carries the required deployment record", () => {
    const deployment = dataset.accountEvents.find((e) => e.eventId === "dep-1842")!;
    expect(deployment.name).toBe("edge-router-v3");
    expect(deployment.zoneId).toBe("zone-api-acme");
    expect(deployment.occurredAt).toBe("2026-08-14T09:58:00Z");
  });
});

describe("lineage", () => {
  it("ties each daily row back to its source events", () => {
    for (const row of dataset.dailyUsage.slice(0, 50)) {
      expect(row.sourceEventCount).toBeGreaterThan(0);
      expect(row.sourceEventFirst.startsWith(row.usageDate)).toBe(true);
      expect(row.sourceEventLast.startsWith(row.usageDate)).toBe(true);
    }
  });

  it("ties each rated charge to a real price version", () => {
    const ids = new Set(dataset.priceVersions.map((p) => p.priceVersionId));
    for (const charge of dataset.ratedCharges) {
      expect(ids.has(charge.priceVersionId)).toBe(true);
    }
  });

  it("ties each invoice line to a rated charge or a subscription", () => {
    const chargeIds = new Set(dataset.ratedCharges.map((r) => r.ratedChargeId));
    for (const line of dataset.invoiceLines) {
      if (line.lineType === "usage") {
        expect(chargeIds.has(line.ratedChargeId!)).toBe(true);
      } else {
        expect(line.ratedChargeId).toBeNull();
      }
    }
  });
});

describe("public API-shaped adapter", () => {
  const records = toBillableUsageRecords(
    dataset.dailyUsage.filter(
      (d) => d.serviceName === "Workers" && d.usageDate.startsWith("2026-08")
    ),
    dataset.zones,
    dataset.priceVersions,
    "USD"
  );

  it("emits the documented field names", () => {
    expect(Object.keys(records[0]).sort()).toEqual(
      [
        "BillingCurrency",
        "BillingPeriodStart",
        "ChargePeriodEnd",
        "ChargePeriodStart",
        "ConsumedQuantity",
        "ConsumedUnit",
        "ContractedCost",
        "CumulatedContractedCost",
        "ServiceFamilyName",
        "ServiceName",
        "PricingQuantity",
        "ZoneId",
        "ZoneName"
      ].sort()
    );
  });

  it("populates numeric fields from the generated data", () => {
    const first = records[0];
    expect(first.BillingPeriodStart).toBe("2026-08-01T00:00:00Z");
    expect(first.ConsumedUnit).toBe("requests");
    expect(first.ServiceFamilyName).toBe("Workers");
    expect(first.ConsumedQuantity).toBeGreaterThan(0);
    expect(first.ZoneName).toMatch(/acme\.example$/);
  });

  it("accumulates contracted cost across the period", () => {
    const last = records[records.length - 1];
    expect(last.CumulatedContractedCost).toBeGreaterThan(last.ContractedCost);
  });
});

/**
 * The property that makes a second account safe to add.
 *
 * The generator used to close over one `ACCOUNT` const and one
 * `mulberry32(SEED)` stream. Drawing a second account from that stream would
 * have made every account's content depend on the order they were generated
 * in — silently moving a golden fact block that the domain, the tools and the
 * agent all assert independently. These hold the profiles apart.
 * `docs/BUILD_PLAN_P1.md` Milestone 6.
 */
describe("account profiles are independent", () => {
  /** A second profile that differs in identity and seed but nothing else. */
  const OTHER: AccountProfile = {
    ...GOLDEN_ACCOUNT,
    seed: 777,
    account: {
      ...GOLDEN_ACCOUNT.account,
      accountId: "zzz999",
      displayName: "Other Corp.",
      primaryZoneId: "zone-api-other",
      primaryZoneName: "api.other.example"
    },
    secondaryZone: { zoneId: "zone-web-other", zoneName: "www.other.example" },
    zoneShare: { "zone-api-other": 75, "zone-web-other": 25 },
    workers: {
      ...GOLDEN_ACCOUNT.workers,
      elevationPercentByZone: { "zone-api-other": 228, "zone-web-other": 115 }
    },
    subscriptionId: "sub-zzz999-enterprise",
    accountEvents: []
  };

  it("generates the golden account identically whatever order it is drawn in", () => {
    // The failure this catches: a shared PRNG, where generating the other
    // account first advances the stream and changes abc123's every quantity.
    const goldenFirst = [GOLDEN_ACCOUNT, OTHER].map((p) =>
      generateSyntheticData(p)
    );
    const goldenLast = [OTHER, GOLDEN_ACCOUNT].map((p) =>
      generateSyntheticData(p)
    );

    expect(emitSql(goldenFirst[0])).toBe(emitSql(goldenLast[1]));
    expect(emitSql(goldenFirst[1])).toBe(emitSql(goldenLast[0]));
  });

  it("gives a second account its own data, not a copy of the first", () => {
    const other = generateSyntheticData(OTHER);
    expect(other.account.accountId).toBe("zzz999");
    expect(emitSql(other)).not.toBe(emitSql(dataset));
    // Same targets, different stream: the monthly total is still exact, but the
    // daily shape underneath it differs.
    expect(consumedInPeriod(other.dailyUsage, "Workers", per("2026-08"))).toBe(
      1_580_000_000
    );
    const goldenDay = dataset.dailyUsage.find(
      (r) => r.serviceName === "Workers" && r.usageDate === "2026-08-20"
    )!;
    const otherDay = other.dailyUsage.find(
      (r) => r.serviceName === "Workers" && r.usageDate === "2026-08-20"
    )!;
    expect(otherDay.quantity).not.toBe(goldenDay.quantity);
  });

  it("binds every generated row to its own account", () => {
    const other = generateSyntheticData(OTHER);
    const ids = new Set<string>([
      ...other.usageEvents.map((e) => e.accountId),
      ...other.dailyUsage.map((r) => r.accountId),
      ...other.ratedCharges.map((r) => r.accountId),
      ...other.invoices.map((i) => i.accountId),
      ...other.priceVersions.map((p) => p.accountId),
      ...other.subscriptions.map((s) => s.accountId),
      ...other.zones.map((z) => z.accountId)
    ]);
    expect([...ids]).toEqual(["zzz999"]);
  });

  it("emits every profile in the registry, deletes once", () => {
    const sql = emitSql(
      ...ACCOUNT_PROFILES.map((p) => generateSyntheticData(p))
    );
    for (const profile of ACCOUNT_PROFILES) {
      expect(sql).toContain(`'${profile.account.accountId}'`);
    }
    // One DELETE per table regardless of account count, or re-seeding a
    // populated database would wipe the account emitted before it.
    expect(sql.match(/DELETE FROM usage_events;/g)).toHaveLength(1);
  });

  it("still emits the golden account as the registry's first entry", () => {
    expect(ACCOUNT_PROFILES[0]).toBe(GOLDEN_ACCOUNT);
  });
});

/**
 * The golden account's bytes, pinned to a recorded value.
 *
 * "Byte-identical across runs" above compares two runs of the *same* code, so
 * it cannot see a change to the generator — it agreed with itself throughout a
 * mutation that moved every quantity in the file. Nothing held the output to a
 * value recorded *before* a change until this test.
 *
 * Deliberately scoped to the golden account rather than `.seed/golden.sql`, so
 * that adding a second profile — which appends rows and changes the file's
 * hash — leaves it untouched. What must not move is `abc123`.
 *
 * If this fails, the generator changed. Either that was the point, in which
 * case the golden fact block in `CLAUDE.md` needs re-verifying before the hash
 * is updated, or a refactor moved data it should not have.
 */
describe("the golden account is pinned", () => {
  const GOLDEN_SQL_SHA256 =
    "9a11702d329896af51fb0e5652dde27f69ce9bccf53452baa8220cf579238af4";

  it("emits exactly the recorded bytes", () => {
    const sql = emitSql(generateSyntheticData(GOLDEN_ACCOUNT));
    expect(createHash("sha256").update(sql).digest("hex")).toBe(
      GOLDEN_SQL_SHA256
    );
  });
});

/**
 * Primary keys are global, not per-account.
 *
 * `price_versions.price_version_id` is a primary key, and both accounts were
 * initially given `price-workers-2026-01`. Two things hid it: `emitSql` writes
 * `INSERT OR REPLACE`, so the seed file loaded cleanly while silently
 * overwriting the golden account's prices with the other account's — and
 * nothing compared ids across profiles. A D1 insert finally rejected it.
 *
 * This checks every id-bearing table, so the next account cannot reintroduce
 * the same collision in a different column.
 */
describe("ids are unique across accounts", () => {
  const all = ACCOUNT_PROFILES.map((p) => generateSyntheticData(p));

  const idsOf = (pick: (d: (typeof all)[number]) => string[]) =>
    all.flatMap(pick);

  it.each([
    ["price_versions", (d: (typeof all)[number]) => d.priceVersions.map((r) => r.priceVersionId)],
    ["subscriptions", (d: (typeof all)[number]) => d.subscriptions.map((r) => r.subscriptionId)],
    ["zones", (d: (typeof all)[number]) => d.zones.map((r) => r.zoneId)],
    ["usage_events", (d: (typeof all)[number]) => d.usageEvents.map((r) => r.eventId)],
    ["rated_charges", (d: (typeof all)[number]) => d.ratedCharges.map((r) => r.ratedChargeId)],
    ["invoices", (d: (typeof all)[number]) => d.invoices.map((r) => r.invoiceId)],
    ["invoice_lines", (d: (typeof all)[number]) => d.invoiceLines.map((r) => r.lineId)],
    ["account_events", (d: (typeof all)[number]) => d.accountEvents.map((r) => r.eventId)],
    ["accounts", (d: (typeof all)[number]) => [d.account.accountId]]
  ])("%s ids collide with no other account", (_table, pick) => {
    const ids = idsOf(pick);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("checks more than one account, or it proves nothing", () => {
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

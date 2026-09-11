import { per } from "./../support/values.js";
import { describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
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
    expect(emitSql(generateSyntheticData(1))).not.toBe(emitSql(dataset));
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

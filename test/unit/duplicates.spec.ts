import { q } from "../support/values.js";
import { describe, expect, it } from "vitest";
import {
  checkDuplicates,
  fingerprint,
  stableHash,
  timestampBucket
} from "../../src/domain/duplicates.js";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { WORKERS_PRICE } from "../../seed/constants.js";
import type { UsageEvent } from "../../src/domain/types.js";

const dataset = generateSyntheticData();
const price = { ...WORKERS_PRICE, accountId: "abc123" };

const augustWorkers = dataset.usageEvents.filter(
  (e) => e.serviceName === "Workers" && e.occurredAt.startsWith("2026-08")
);

describe("fingerprinting", () => {
  it("is stable for identical input", () => {
    expect(stableHash("abc123|Workers")).toBe(stableHash("abc123|Workers"));
    expect(stableHash("a")).not.toBe(stableHash("b"));
  });

  it("buckets timestamps to the minute", () => {
    expect(timestampBucket("2026-08-14T10:20:00Z")).toBe(
      timestampBucket("2026-08-14T10:20:59Z")
    );
    expect(timestampBucket("2026-08-14T10:20:00Z")).not.toBe(
      timestampBucket("2026-08-14T10:21:00Z")
    );
  });
});

describe("duplicate detection on the golden scenario", () => {
  const report = checkDuplicates(augustWorkers, price);

  it("finds no exact duplicates", () => {
    expect(report.exactCount).toBe(0);
    expect(report.exactQuantity).toBe(0);
    expect(report.exactCostCents).toBe(0);
  });

  it("finds no probable duplicates", () => {
    expect(report.probableCount).toBe(0);
    expect(report.probableQuantity).toBe(0);
    expect(report.probableCostCents).toBe(0);
  });

  it("actually checked every event", () => {
    expect(augustWorkers.length).toBeGreaterThan(1000);
    expect(report.fingerprintsChecked).toBe(augustWorkers.length);
    expect(report.sampledRecordIds).toEqual([]);
  });

  it("states its method", () => {
    expect(report.method).toMatch(/event_id/);
    expect(report.method).toMatch(/60s/);
  });

  it("has globally unique event ids across the dataset", () => {
    const ids = new Set(dataset.usageEvents.map((e) => e.eventId));
    expect(ids.size).toBe(dataset.usageEvents.length);
  });
});

describe("duplicate detection when duplicates exist", () => {
  const base = augustWorkers[0];

  it("catches a repeated event id", () => {
    const report = checkDuplicates([...augustWorkers, { ...base }], price);
    expect(report.exactCount).toBe(1);
    expect(report.exactQuantity).toBe(base.quantity);
    expect(report.exactCostCents).toBeGreaterThan(0);
    expect(report.sampledRecordIds).toContain(base.eventId);
  });

  it("catches a distinct id sharing a fingerprint", () => {
    const twin: UsageEvent = { ...base, eventId: `${base.eventId}-retry` };
    expect(fingerprint(twin)).toBe(fingerprint(base));

    const report = checkDuplicates([...augustWorkers, twin], price);
    expect(report.exactCount).toBe(0);
    expect(report.probableCount).toBe(1);
    expect(report.probableQuantity).toBe(base.quantity);
  });

  it("does not flag events that differ only in quantity", () => {
    const different: UsageEvent = {
      ...base,
      eventId: `${base.eventId}-other`,
      quantity: q(base.quantity + 1)
    };
    const report = checkDuplicates([...augustWorkers, different], price);
    expect(report.probableCount).toBe(0);
  });

  it("reports duplicates without removing them", () => {
    const events = [...augustWorkers, { ...base }];
    const report = checkDuplicates(events, price);
    expect(report.exactCount).toBe(1);
    // The input is untouched: detection never mutates the ledger.
    expect(events).toHaveLength(augustWorkers.length + 1);
  });
});

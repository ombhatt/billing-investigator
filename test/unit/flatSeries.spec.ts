import { day, per, q } from "../support/values.js";
import { describe, expect, it } from "vitest";
import {
  detectChangePoint,
  MATERIAL_RATIO,
  type DailyPoint
} from "../../src/domain/changePoint.js";
import { applyToolFacts, emptyFacts } from "../../src/tools/facts.js";
import { deterministicSummary } from "../../src/agent/summary.js";
import type { CompletionAssessment } from "../../src/agent/completion.js";

/**
 * Constant usage is not a usage shift.
 *
 * The scan always produces a best row, and that was being returned as
 * `detected: true`. On a flat 31-day series every candidate ties at ratio 1.00,
 * so the earliest tie won and the tool reported "2026-08-08: daily volume moved
 * from 1,000 to 1,000 (1.00x)" as *confirmed*. Only the date survived into the
 * fact block, so the qualifiers that said not to believe it — ratio 1,
 * `material: false`, confidence low — were discarded, the summary asserted
 * "Usage shifted on 2026-08-08", and the event window anchored on that date
 * produced an operational-event correlation for a change that never happened.
 */

const august = (quantity: (index: number) => number): DailyPoint[] =>
  Array.from({ length: 31 }, (_, index) => ({
    date: day(`2026-08-${String(index + 1).padStart(2, "0")}`),
    quantity: q(quantity(index))
  }));

const FLAT = august(() => 1000);
/** Movement, but far below the threshold: the series has not changed regime. */
const NOISE = august((i) => 1000 + (i % 5) * 30);
const REAL_SHIFT = august((i) => (i < 13 ? 1000 : 2600));

describe("a scan candidate is not an accepted change point", () => {
  it("rejects a flat series instead of naming a date", () => {
    const result = detectChangePoint(FLAT);

    expect(result.detected).toBe(false);
    expect(result.changeDate).toBeNull();
    expect(result.ratio).toBe(1);
    expect(result.material).toBe(false);
  });

  it("still says what it considered and why it declined", () => {
    // Rejecting must not mean reporting nothing: the operator should be able to
    // see the scan ran and what the strongest candidate looked like.
    const result = detectChangePoint(FLAT);

    expect(result.candidateDate).toBe("2026-08-08");
    expect(result.reason).toContain("2026-08-08");
    expect(result.reason).toContain("1.00x");
    expect(result.pointsEvaluated).toBe(31);
  });

  it("rejects immaterial noise", () => {
    const result = detectChangePoint(NOISE);

    expect(result.detected).toBe(false);
    expect(result.changeDate).toBeNull();
    expect(result.ratio!).toBeLessThan(MATERIAL_RATIO);
  });

  it("still accepts a real shift", () => {
    // The control. Without it the three above would pass on a detector that
    // never detects anything.
    const result = detectChangePoint(REAL_SHIFT);

    expect(result.detected).toBe(true);
    expect(result.changeDate).toBe("2026-08-14");
    expect(result.ratio!).toBeGreaterThanOrEqual(MATERIAL_RATIO);
  });

  it("accepts a sustained fall, which is a change point too", () => {
    const result = detectChangePoint(august((i) => (i < 13 ? 2600 : 1000)));

    expect(result.detected).toBe(true);
    expect(result.ratio!).toBeLessThan(1);
    // No positive cost impact, so it is a real change that is not material.
    expect(result.material).toBe(false);
  });
});

describe("a rejected candidate never becomes a fact", () => {
  it("leaves the date and its qualifiers null", () => {
    const facts = applyToolFacts(
      emptyFacts(),
      "detect_usage_change_point",
      detectChangePoint(FLAT),
      { changeDate: null }
    );

    expect(facts.change_date).toBeNull();
    expect(facts.change_point_material).toBeNull();
    expect(facts.change_point_confidence).toBeNull();
  });

  it("keeps the qualifiers alongside an accepted one", () => {
    const facts = applyToolFacts(
      emptyFacts(),
      "detect_usage_change_point",
      detectChangePoint(REAL_SHIFT),
      { changeDate: null }
    );

    expect(facts.change_date).toBe("2026-08-14");
    expect(facts.change_point_material).not.toBeNull();
    expect(facts.change_point_confidence).not.toBeNull();
  });
});

describe("the summary claims no shift it cannot show", () => {
  const assessment: CompletionAssessment = {
    invoiceAppearsCorrect: false,
    confidence: "low",
    confidenceReasons: [],
    blockers: []
  };

  it("says nothing about a shift, or an event, on flat usage", () => {
    const facts = applyToolFacts(
      emptyFacts(),
      "detect_usage_change_point",
      detectChangePoint(FLAT),
      { changeDate: null }
    );

    const summary = deterministicSummary(facts, [], assessment, {
      currentPeriod: per("2026-08"),
      comparisonPeriod: per("2026-07")
    });
    const text = [summary.finding, ...summary.evidence, summary.assessment].join(" ");

    expect(text).not.toMatch(/shifted/i);
    expect(text).not.toContain("2026-08-08");
  });
});

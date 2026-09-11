import { per } from "../support/values.js";
import { describe, expect, it } from "vitest";
import { ALLOWED_TOOLS, TOOL_CATALOG } from "../../src/tools/catalog.js";
import { newInvestigation } from "../../src/agent/loop.js";
import { inputFor } from "../../src/agent/toolInputs.js";
import type { InvestigationRecord } from "../../src/agent/types.js";

const ACCOUNT = "abc123";

/** A record with everything the builders can ask for. */
function ready(overrides: Partial<InvestigationRecord> = {}): InvestigationRecord {
  const base = newInvestigation("inv-1", ACCOUNT, "Workers");
  return {
    ...base,
    currentPeriod: per("2026-08"),
    comparisonPeriod: per("2026-07"),
    facts: { ...base.facts, change_date: "2026-08-14" },
    ...overrides
  };
}

/**
 * The arguments every tool call is made with.
 *
 * These were unreachable while they lived inside `loop.ts`: the only way to ask
 * "does the event window anchor on the change date?" was to run a whole turn
 * against D1 and read the answer back out of an envelope. So the windows were
 * asserted where they were convenient to see — through the tool's *output* —
 * and never at the point they are chosen.
 *
 * Extracted to `src/agent/toolInputs.ts`, the question is a function call.
 */
describe("tool input construction", () => {
  it("builds arguments its own tool accepts, for every tool on the allowlist", () => {
    // The compiler checks each builder's shape. It cannot check a *format*:
    // a period regex, an ISO date, a timestamp. Those are in the zod schemas,
    // and until now nothing ran a built input through them.
    let checked = 0;

    for (const tool of ALLOWED_TOOLS) {
      const input = inputFor(tool, ready());
      expect(input, `${tool} built no arguments from a complete record`).not.toBeNull();

      const parsed = TOOL_CATALOG[tool].schema.safeParse(input);
      expect(
        parsed.success ? null : parsed.error.issues[0],
        `${tool} built arguments its own schema rejects`
      ).toBeNull();
      checked++;
    }

    // Driven off the allowlist, so a tenth tool is covered on arrival; the
    // count guards against an empty allowlist passing vacuously.
    expect(checked).toBe(9);
  });

  it("scopes every tool to the investigation's account", () => {
    // CLAUDE.md rule 5 is enforced again inside `createTool`, which compares
    // the argument against the bound account. This is the other half: no
    // builder may *name* an account the investigation is not bound to.
    for (const tool of ALLOWED_TOOLS) {
      expect(inputFor(tool, ready())?.accountId, `${tool} is off-account`).toBe(
        ACCOUNT
      );
    }
  });

  it("builds nothing but account context before the periods are known", () => {
    const unclassified = ready({ currentPeriod: null, comparisonPeriod: null });

    for (const tool of ALLOWED_TOOLS) {
      const input = inputFor(tool, unclassified);
      if (tool === "get_account_context") {
        // Needs only the account, and is the prelude step that runs first.
        expect(input).not.toBeNull();
      } else {
        expect(input, `${tool} invented a period`).toBeNull();
      }
    }
  });

  it("anchors the event window on the change date, one day either side", () => {
    const input = inputFor("get_account_events", ready());

    expect(input).toEqual({
      accountId: ACCOUNT,
      startTimestamp: "2026-08-13T00:00:00.000Z",
      endTimestamp: "2026-08-15T00:00:00.000Z"
    });
  });

  it("builds no event window without a change point to anchor it", () => {
    // Invariant 21: a correlation window centred on nothing would return the
    // account's events regardless, and any one of them could then be read as
    // correlated with a change that was never detected.
    const noChangePoint = ready({
      facts: { ...newInvestigation("x", ACCOUNT, "Workers").facts, change_date: null }
    });

    expect(inputFor("get_account_events", noChangePoint)).toBeNull();
  });

  it("asks for prices across both periods, not just the current one", () => {
    // Invariant 22: a version has to span the whole window being rated. A
    // request starting at the current period's first day cannot tell a price
    // that changed between the periods from one that never moved.
    expect(inputFor("get_price_versions", ready())).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-08-31"
    });
  });

  it("asks for the comparison window alongside the current usage series", () => {
    // ARCHITECTURE.md §19: the "which zone generated the increase?" follow-up
    // is answered from persisted evidence with no new tool calls, so the
    // baseline has to be fetched while the series is.
    expect(inputFor("get_usage_timeseries", ready())).toMatchObject({
      startDate: "2026-08-01",
      endDate: "2026-08-31",
      comparisonStartDate: "2026-07-01",
      comparisonEndDate: "2026-07-31"
    });
  });

  it("checks the service it is given, not the driver, when one is named", () => {
    // Invariant 23: price and duplicate findings are stated invoice-wide, so
    // each runs once per metered service. A builder that ignored the service
    // argument would check the driver nine times and call it invoice-wide.
    const record = ready();

    for (const tool of ["check_duplicate_usage", "get_price_versions"] as const) {
      expect(inputFor(tool, record, "Workers AI")).toMatchObject({
        serviceName: "Workers AI"
      });
      expect(inputFor(tool, record)).toMatchObject({ serviceName: "Workers" });
    }
  });

  it("scopes the change-point scan to the focus service", () => {
    expect(inputFor("detect_usage_change_point", ready({ focusService: "R2" })))
      .toMatchObject({ serviceName: "R2" });
  });
});

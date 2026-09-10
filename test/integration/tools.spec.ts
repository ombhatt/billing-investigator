import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { generateSyntheticData } from "../../seed/generateSyntheticData.js";
import { seedDataset } from "./seedD1.js";
import {
  ALLOWED_TOOLS,
  isAllowedTool,
  TOOL_HANDLERS,
  ToolRunner
} from "../../src/tools/registry.js";
import { isFailure, type ToolResult } from "../../src/types/tools.js";
import type { ToolDeps } from "../../src/tools/createTool.js";

const dataset = generateSyntheticData();
const deps: ToolDeps = { db: env.DB, investigationAccountId: "abc123" };

beforeAll(async () => {
  await seedDataset(env.DB, dataset);
});

/** Minimal valid input for every tool, used by the cross-cutting checks. */
const VALID_INPUT: Record<string, Record<string, unknown>> = {
  get_account_context: { accountId: "abc123" },
  compare_invoices: {
    accountId: "abc123",
    currentPeriod: "2026-08",
    comparisonPeriod: "2026-07"
  },
  decompose_variance: {
    accountId: "abc123",
    currentPeriod: "2026-08",
    comparisonPeriod: "2026-07"
  },
  get_usage_timeseries: {
    accountId: "abc123",
    serviceName: "Workers",
    startDate: "2026-08-01",
    endDate: "2026-08-31"
  },
  get_price_versions: {
    accountId: "abc123",
    serviceName: "Workers",
    startDate: "2026-07-01",
    endDate: "2026-08-31"
  },
  detect_usage_change_point: {
    accountId: "abc123",
    serviceName: "Workers",
    startDate: "2026-08-01",
    endDate: "2026-08-31"
  },
  get_account_events: {
    accountId: "abc123",
    startTimestamp: "2026-08-13T00:00:00Z",
    endTimestamp: "2026-08-15T00:00:00Z"
  },
  check_duplicate_usage: {
    accountId: "abc123",
    serviceName: "Workers",
    startDate: "2026-08-01",
    endDate: "2026-08-31"
  },
  reconcile_invoice: { accountId: "abc123", period: "2026-08" }
};

function unwrap<T>(result: ToolResult<T>): T {
  if (isFailure(result)) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

describe("allowlist", () => {
  it("exposes exactly the nine P0 tools", () => {
    expect(ALLOWED_TOOLS).toEqual([
      "check_duplicate_usage",
      "compare_invoices",
      "decompose_variance",
      "detect_usage_change_point",
      "get_account_context",
      "get_account_events",
      "get_price_versions",
      "get_usage_timeseries",
      "reconcile_invoice"
    ]);
  });

  it("rejects unknown tool names", async () => {
    expect(isAllowedTool("drop_tables")).toBe(false);
    expect(isAllowedTool("constructor")).toBe(false);
    expect(isAllowedTool("__proto__")).toBe(false);

    const runner = new ToolRunner(deps);
    const result = await runner.run("drop_tables", { accountId: "abc123" });
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("UNKNOWN_TOOL");
  });

  it("has a valid-input fixture for every allowlisted tool", () => {
    expect(Object.keys(VALID_INPUT).sort()).toEqual(ALLOWED_TOOLS);
  });
});

describe.each(ALLOWED_TOOLS)("%s — contract", (toolName) => {
  const handler = TOOL_HANDLERS[toolName];
  const input = VALID_INPUT[toolName];

  it("returns every required envelope field", async () => {
    const result = await handler(input, deps);
    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;

    expect(result.tool).toBe(toolName);
    expect(() => new Date(result.executedAt).toISOString()).not.toThrow();
    expect(Array.isArray(result.sourceRecordIds)).toBe(true);
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(Array.isArray(result.dataLimitations)).toBe(true);
    expect(result.data).toBeDefined();
  });

  it("emits evidence cards with all six required fields", async () => {
    const result = await handler(input, deps);
    if (isFailure(result)) throw new Error("unexpected failure");

    expect(result.evidence.length).toBeGreaterThan(0);
    for (const card of result.evidence) {
      expect(typeof card.label).toBe("string");
      expect(card.label.length).toBeGreaterThan(0);
      expect(typeof card.value).toBe("string");
      expect(card.source).toBe(toolName);
      expect(Array.isArray(card.recordIds)).toBe(true);
      expect(card).toHaveProperty("period");
      expect(["confirmed", "correlated", "not_found", "unresolved"]).toContain(
        card.status
      );
    }
  });

  it("rejects a missing account id", async () => {
    const { accountId: _omit, ...rest } = input;
    const result = await handler(rest, deps);
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects unparseable input", async () => {
    for (const bad of [null, "a string", 42, []]) {
      const result = await handler(bad, deps);
      expect(isFailure(result)).toBe(true);
      if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");
    }
  });

  it("denies an account outside the investigation scope", async () => {
    const result = await handler({ ...input, accountId: "other99" }, deps);
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error.code).toBe("ACCOUNT_SCOPE_VIOLATION");
      expect(result.error.message).toContain("abc123");
    }
  });

  it("rejects an injection-shaped account id without touching the data", async () => {
    const result = await handler(
      { ...input, accountId: "abc123'; DROP TABLE invoices;--" },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");

    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM invoices").first<{
      n: number;
    }>();
    expect(row!.n).toBe(3);
  });

  it("never leaks SQL or internals in an error message", async () => {
    const result = await handler({ ...input, accountId: "!!bad!!" }, deps);
    if (!isFailure(result)) throw new Error("expected failure");
    expect(result.error.message).not.toMatch(/SELECT|INSERT|D1_|sqlite|at Object/i);
  });
});

describe("get_account_context", () => {
  it("returns the seeded account and its invoices", async () => {
    const data = unwrap(
      await TOOL_HANDLERS.get_account_context(
        VALID_INPUT.get_account_context,
        deps
      )
    ) as {
      displayName: string;
      currency: string;
      zones: { zoneId: string }[];
      availableInvoices: { period: string }[];
    };

    expect(data.displayName).toBe("Acme Corp.");
    expect(data.currency).toBe("USD");
    expect(data.zones.map((z) => z.zoneId).sort()).toEqual([
      "zone-api-acme",
      "zone-web-acme"
    ]);
    expect(data.availableInvoices.map((i) => i.period)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08"
    ]);
  });

  it("reports a safe not-found for an unknown in-scope account", async () => {
    const result = await TOOL_HANDLERS.get_account_context(
      { accountId: "ghost1" },
      { db: env.DB, investigationAccountId: "ghost1" }
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

describe("period and range validation", () => {
  it("rejects a malformed period", async () => {
    const result = await TOOL_HANDLERS.reconcile_invoice(
      { accountId: "abc123", period: "2026-13" },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects an impossible calendar date", async () => {
    const result = await TOOL_HANDLERS.get_usage_timeseries(
      {
        ...VALID_INPUT.get_usage_timeseries,
        startDate: "2026-02-30"
      },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("rejects an inverted date range", async () => {
    const result = await TOOL_HANDLERS.get_usage_timeseries(
      {
        ...VALID_INPUT.get_usage_timeseries,
        startDate: "2026-08-31",
        endDate: "2026-08-01"
      },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_DATE_RANGE");
  });

  it("rejects a range beyond the maximum span", async () => {
    const result = await TOOL_HANDLERS.get_usage_timeseries(
      {
        ...VALID_INPUT.get_usage_timeseries,
        startDate: "2020-01-01",
        endDate: "2026-08-31"
      },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_DATE_RANGE");
  });

  it("rejects identical comparison periods", async () => {
    const result = await TOOL_HANDLERS.compare_invoices(
      { accountId: "abc123", currentPeriod: "2026-08", comparisonPeriod: "2026-08" },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_PERIODS");
  });

  it("reports a missing invoice rather than inventing one", async () => {
    const result = await TOOL_HANDLERS.reconcile_invoice(
      { accountId: "abc123", period: "2026-01" },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVOICE_NOT_FOUND");
  });

  it("reports absent usage as not_found instead of failing", async () => {
    const data = unwrap(
      await TOOL_HANDLERS.get_usage_timeseries(
        {
          accountId: "abc123",
          serviceName: "Nonexistent",
          startDate: "2026-08-01",
          endDate: "2026-08-31"
        },
        deps
      )
    ) as { points: unknown[]; totalQuantity: number };
    expect(data.points).toEqual([]);
    expect(data.totalQuantity).toBe(0);
  });
});

describe("zone filtering", () => {
  it("narrows the series to one zone", async () => {
    const all = unwrap(
      await TOOL_HANDLERS.get_usage_timeseries(
        VALID_INPUT.get_usage_timeseries,
        deps
      )
    ) as { totalQuantity: number; zones: unknown[] };
    const primary = unwrap(
      await TOOL_HANDLERS.get_usage_timeseries(
        { ...VALID_INPUT.get_usage_timeseries, zoneId: "zone-api-acme" },
        deps
      )
    ) as { totalQuantity: number; zones: { zoneId: string }[] };

    expect(all.zones).toHaveLength(2);
    expect(primary.zones).toHaveLength(1);
    expect(primary.zones[0].zoneId).toBe("zone-api-acme");
    expect(primary.totalQuantity).toBeLessThan(all.totalQuantity);
  });

  it("rejects a malformed zone id", async () => {
    const result = await TOOL_HANDLERS.get_usage_timeseries(
      { ...VALID_INPUT.get_usage_timeseries, zoneId: "zone'; DROP--" },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");
  });
});

describe("result caching within an investigation", () => {
  it("reuses an identical call without re-querying", async () => {
    const runner = new ToolRunner(deps);
    const first = await runner.run("compare_invoices", VALID_INPUT.compare_invoices);
    const second = await runner.run("compare_invoices", VALID_INPUT.compare_invoices);

    expect(second).toBe(first);
    expect(runner.executions[0].cached).toBe(false);
    expect(runner.executions[1].cached).toBe(true);
  });

  it("treats reordered arguments as the same call", async () => {
    const runner = new ToolRunner(deps);
    await runner.run("compare_invoices", {
      accountId: "abc123",
      currentPeriod: "2026-08",
      comparisonPeriod: "2026-07"
    });
    await runner.run("compare_invoices", {
      comparisonPeriod: "2026-07",
      currentPeriod: "2026-08",
      accountId: "abc123"
    });
    expect(runner.executions[1].cached).toBe(true);
  });

  it("treats different arguments as a different call", async () => {
    const runner = new ToolRunner(deps);
    await runner.run("reconcile_invoice", { accountId: "abc123", period: "2026-08" });
    await runner.run("reconcile_invoice", { accountId: "abc123", period: "2026-07" });
    expect(runner.executions[1].cached).toBe(false);
  });

  it("does not cache failures", async () => {
    const runner = new ToolRunner(deps);
    const bad = { accountId: "abc123", period: "2026-01" };
    await runner.run("reconcile_invoice", bad);
    await runner.run("reconcile_invoice", bad);
    expect(runner.executions[1].cached).toBe(false);
  });
});

/**
 * Flat usage must not surface as a confirmed shift.
 *
 * July is a flat month in the seed — the golden change point is August 14 — so
 * this runs the real tool over real data with nothing to find. It previously
 * returned `detected: true` with the earliest tied candidate and a `confirmed`
 * evidence card reading "daily volume moved from N to N (1.00x)".
 */
describe("detect_usage_change_point on a month that did not change", () => {
  it("reports no change point rather than the strongest tie", async () => {
    const result = await TOOL_HANDLERS.detect_usage_change_point(
      {
        accountId: "abc123",
        serviceName: "Workers",
        startDate: "2026-07-01",
        endDate: "2026-07-31"
      },
      deps
    );
    if ("error" in result) throw new Error(result.error.code);

    const data = result.data as {
      detected: boolean;
      changeDate: string | null;
      candidateDate: string | null;
      ratio: number | null;
      material: boolean;
    };

    expect(data.detected).toBe(false);
    expect(data.changeDate).toBeNull();
    expect(data.material).toBe(false);
    // The scan still reports what it looked at.
    expect(data.candidateDate).not.toBeNull();
  });

  it("marks the evidence card not_found and claims no movement", async () => {
    const result = await TOOL_HANDLERS.detect_usage_change_point(
      {
        accountId: "abc123",
        serviceName: "Workers",
        startDate: "2026-07-01",
        endDate: "2026-07-31"
      },
      deps
    );
    if ("error" in result) throw new Error(result.error.code);

    const card = result.evidence[0];
    expect(card.status).toBe("not_found");
    // The claim shape, not the word: "daily volume moved from N to N" is the
    // assertion that must not appear. The reason may well say what it declined
    // to accept, and saying "moved 1.00x, inside the threshold" is honest.
    expect(card.value).not.toMatch(/daily volume moved from/);
    expect(card.value).toContain("no sustained change");
    // And no cost-impact card, which only accompanies an accepted shift.
    expect(result.evidence).toHaveLength(1);
  });

  it("still finds the August change point", async () => {
    // The control: the month that did change must still report it.
    const result = await TOOL_HANDLERS.detect_usage_change_point(
      {
        accountId: "abc123",
        serviceName: "Workers",
        startDate: "2026-08-01",
        endDate: "2026-08-31"
      },
      deps
    );
    if ("error" in result) throw new Error(result.error.code);

    const data = result.data as { detected: boolean; changeDate: string | null };
    expect(data.detected).toBe(true);
    expect(data.changeDate).toBe("2026-08-14");
    expect(result.evidence[0].status).toBe("confirmed");
  });
});

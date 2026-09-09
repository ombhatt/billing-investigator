import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getAccountContext,
  TOOL_NAME
} from "../../src/tools/getAccountContext.js";
import { isAllowedTool } from "../../src/tools/definitions.js";
import { isFailure } from "../../src/types/tools.js";

const SEED = `INSERT OR REPLACE INTO accounts
  (account_id, display_name, plan_type, currency, tax_status,
   primary_zone_id, primary_zone_name, is_synthetic)
  VALUES ('abc123','Acme Corp.','Synthetic Enterprise','USD','exempt',
          'zone-api-acme','api.acme.example',1)`;

const deps = { db: env.DB, investigationAccountId: "abc123" };

beforeAll(async () => {
  await env.DB.prepare(SEED).run();
});

describe("get_account_context — tool contract", () => {
  it("returns the seeded golden account", async () => {
    const result = await getAccountContext({ accountId: "abc123" }, deps);
    if (isFailure(result)) throw new Error(`unexpected failure: ${result.error.code}`);

    expect(result.data.accountId).toBe("abc123");
    expect(result.data.displayName).toBe("Acme Corp.");
    expect(result.data.planType).toBe("Synthetic Enterprise");
    expect(result.data.currency).toBe("USD");
    expect(result.data.primaryZoneName).toBe("api.acme.example");
    expect(result.data.isSynthetic).toBe(true);
  });

  it("returns every required envelope field", async () => {
    const result = await getAccountContext({ accountId: "abc123" }, deps);
    if (isFailure(result)) throw new Error("unexpected failure");

    expect(result.tool).toBe(TOOL_NAME);
    expect(() => new Date(result.executedAt).toISOString()).not.toThrow();
    expect(Array.isArray(result.sourceRecordIds)).toBe(true);
    expect(Array.isArray(result.evidence)).toBe(true);
    expect(Array.isArray(result.dataLimitations)).toBe(true);
    expect(result.sourceRecordIds).toContain("accounts:abc123");
  });

  it("emits an evidence card with all six required fields", async () => {
    const result = await getAccountContext({ accountId: "abc123" }, deps);
    if (isFailure(result)) throw new Error("unexpected failure");

    const card = result.evidence[0];
    expect(card).toBeDefined();
    expect(card.label).toBeTruthy();
    expect(card.value).toContain("Acme Corp.");
    expect(card.source).toBe(TOOL_NAME);
    expect(card.recordIds).toContain("accounts:abc123");
    expect(card).toHaveProperty("period");
    expect(card.status).toBe("confirmed");
  });

  it("rejects a malformed account id before querying D1", async () => {
    const result = await getAccountContext(
      { accountId: "abc123'; DROP TABLE accounts;--" },
      deps
    );
    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;
    expect(result.error.code).toBe("INVALID_INPUT");

    // The table must still be intact.
    const row = await env.DB.prepare(
      "SELECT account_id FROM accounts WHERE account_id = ?"
    )
      .bind("abc123")
      .first();
    expect(row).not.toBeNull();
  });

  it("rejects a missing account id", async () => {
    const result = await getAccountContext({}, deps);
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) expect(result.error.code).toBe("INVALID_INPUT");
  });

  it("denies reading an account outside the investigation scope", async () => {
    const result = await getAccountContext({ accountId: "other99" }, deps);
    expect(isFailure(result)).toBe(true);
    if (isFailure(result)) {
      expect(result.error.code).toBe("ACCOUNT_SCOPE_VIOLATION");
    }
  });

  it("returns a safe not-found for an unknown in-scope account", async () => {
    const result = await getAccountContext(
      { accountId: "ghost1" },
      { db: env.DB, investigationAccountId: "ghost1" }
    );
    expect(isFailure(result)).toBe(true);
    if (!isFailure(result)) return;
    expect(result.error.code).toBe("ACCOUNT_NOT_FOUND");
    expect(result.error.message).not.toMatch(/SELECT|SQL|D1_/i);
  });

  it("does not fabricate invoices before they are seeded", async () => {
    const result = await getAccountContext({ accountId: "abc123" }, deps);
    if (isFailure(result)) throw new Error("unexpected failure");
    expect(result.data.availableInvoices).toEqual([]);
    expect(result.dataLimitations.length).toBeGreaterThan(0);
  });
});

describe("tool allowlist", () => {
  it("admits the implemented tool", () => {
    expect(isAllowedTool(TOOL_NAME)).toBe(true);
  });

  it("rejects unknown and not-yet-implemented tool names", () => {
    expect(isAllowedTool("reconcile_invoice")).toBe(false);
    expect(isAllowedTool("drop_tables")).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOLS,
  isAllowedTool,
  TOOL_CATALOG
} from "../../src/tools/catalog.js";

const ROOT = join(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/**
 * The catalog gives every tool one place to declare its name, schema, handler
 * and result type, so a consumer that reads a field the tool stopped returning
 * fails the build.
 *
 * The compile-time half of this guarantee is asserted in
 * `test/types/toolContract.ts`, where each `@ts-expect-error` is a claim that a
 * particular mistake cannot compile — a runtime test could not prove that. What
 * is left here is the runtime boundary and the structural rules that keep the
 * erasure from creeping back.
 */

describe("the runtime boundary", () => {
  it("narrows an allowlisted name and rejects everything else", () => {
    for (const name of ALLOWED_TOOLS) expect(isAllowedTool(name)).toBe(true);

    // Inherited property names are the interesting negatives: `Object.hasOwn`
    // is what stops `constructor` and `__proto__` resolving to something.
    for (const hostile of [
      "drop_tables",
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      ""
    ]) {
      expect(isAllowedTool(hostile), hostile).toBe(false);
    }
  });

  it("keeps one allowlist, not two", () => {
    expect(ALLOWED_TOOLS).toEqual(Object.keys(TOOL_CATALOG).sort());
    expect(ALLOWED_TOOLS).toHaveLength(9);
  });

  it("gives every tool both a schema and a handler", () => {
    for (const [name, entry] of Object.entries(TOOL_CATALOG)) {
      expect(typeof entry.handler, name).toBe("function");
      expect(typeof entry.schema.safeParse, name).toBe("function");
    }
  });

  it("still validates untrusted input at runtime, not only at compile time", () => {
    // The compiler protects the server's own call sites. Arguments that came
    // from the model are checked here, by the schema, at execution.
    const parsed = TOOL_CATALOG.reconcile_invoice.schema.safeParse({
      accountId: "abc123",
      period: "not-a-period"
    });
    expect(parsed.success).toBe(false);
  });
});

describe("the erasure does not creep back", () => {
  it("keeps the erased view to one named, documented place", () => {
    expect(read("src/tools/registry.ts")).toContain("export function erasedHandler");
  });

  it("has no consumer reconstructing a tool result by hand", () => {
    // These two were the reviewer's examples: a switch over tool names with an
    // `as` cast per branch, asserting shapes nothing checked.
    expect(read("src/tools/facts.ts")).not.toMatch(/data as \{/);
    expect(read("src/agent/loop.ts")).not.toMatch(/data as \{/);
  });

  it("declares the catalog without an annotation that would widen it", () => {
    // `const TOOL_CATALOG: Record<string, ...>` would erase every entry back to
    // the shape this exists to avoid. `satisfies` checks without widening.
    const catalog = read("src/tools/catalog.ts");
    expect(catalog).toMatch(/export const TOOL_CATALOG = \{/);
    expect(catalog).toContain("} satisfies Record<");
  });
});

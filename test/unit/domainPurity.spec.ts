import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const DOMAIN_DIR = join(import.meta.dirname, "../../src/domain");

interface Source {
  file: string;
  dir: string;
  source: string;
}

/** Recursive, so a future `src/domain/<subdir>/` is covered on the day it appears. */
function read(dir: string): Source[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return read(path);
    if (!entry.name.endsWith(".ts")) return [];
    return [
      {
        file: relative(DOMAIN_DIR, path),
        dir,
        source: readFileSync(path, "utf8")
      }
    ];
  });
}

/**
 * Every module specifier in a source file: static imports and re-exports
 * (`[^;]` spans newlines but stops at the statement, so a multi-line import is
 * read whole and a side-effect import cannot swallow the next statement),
 * bare side-effect imports, and the dynamic `import()` / `require()` forms.
 */
function specifiers(source: string): string[] {
  const patterns = [
    /^[ \t]*(?:import|export)[ \t][^;]*?\bfrom[ \t\n\r]*["']([^"']+)["']/gm,
    /^[ \t]*import[ \t]*["']([^"']+)["']/gm,
    /\b(?:import|require)[ \t]*\([ \t]*["']([^"']+)["']/g
  ];
  return patterns.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1])
  );
}

/** Comments describe the boundary; only code can cross it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * Runtime types that `worker-configuration.d.ts` declares **globally**. The
 * import scan below cannot see these: that file is in tsconfig's `include`, so
 * `declare abstract class D1Database` is in scope everywhere with no import to
 * flag. A domain module could take a `D1Database` parameter and typecheck
 * cleanly. That is the hole this list closes.
 */
const RUNTIME_GLOBALS = [
  "D1Database",
  "D1PreparedStatement",
  "D1Result",
  "D1ExecResult",
  "DurableObject",
  "DurableObjectState",
  "DurableObjectStorage",
  "DurableObjectNamespace",
  "DurableObjectStub",
  "KVNamespace",
  "R2Bucket",
  "Ai",
  "AiOptions",
  "Fetcher",
  "Env",
  "ExecutionContext",
  "ScheduledController",
  "Cloudflare"
];

/**
 * `src/domain/` holds every calculation whose answer is money, and its one
 * structural guarantee is that those calculations are reproducible anywhere:
 * no database, no model, no binding, no Worker runtime. CLAUDE.md calls this
 * "what makes the financial logic provable".
 *
 * Running the unit project in the `node` environment tests that guarantee only
 * where it is self-enforcing — an import that fails to resolve in Node. It says
 * nothing about `import type { D1Database } from "@cloudflare/workers-types"`,
 * which is erased before a test ever runs, and nothing at all about the ambient
 * globals below. Type-only references are how this boundary erodes first,
 * precisely because each one looks harmless.
 *
 * Static, like `sqlSafety.spec.ts`: a behavioural test can only prove the
 * inputs it happens to try, and this is a property of the whole directory.
 */
describe("domain layer purity", () => {
  const sources = read(DOMAIN_DIR);

  it("found the domain sources to scan", () => {
    // Guards the scan itself: a directory rename would otherwise leave every
    // check below iterating an empty list and passing vacuously.
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  it("imports nothing from outside src/domain", () => {
    let importsChecked = 0;

    for (const { file, dir, source } of sources) {
      for (const specifier of specifiers(source)) {
        importsChecked++;

        // A bare specifier is a package, and a package is a dependency on
        // something other than this directory — Cloudflare or otherwise.
        expect(
          specifier,
          `${file} imports the package "${specifier}"; src/domain may only import its own modules`
        ).toMatch(/^\.{1,2}\//);

        const target = resolve(dir, specifier);
        expect(
          target.startsWith(DOMAIN_DIR + sep),
          `${file} imports "${specifier}", which resolves outside src/domain`
        ).toBe(true);
      }
    }

    expect(importsChecked).toBeGreaterThanOrEqual(10);
  });

  it("references no ambient Cloudflare runtime type", () => {
    const pattern = new RegExp(`\\b(${RUNTIME_GLOBALS.join("|")})\\b`);

    for (const { file, source } of sources) {
      const match = pattern.exec(withoutComments(source));
      expect(
        match?.[1],
        `${file} references the runtime global ${match?.[1]}`
      ).toBeUndefined();
    }
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_DIR = join(import.meta.dirname, "../../src/repositories");
const TOOLS_DIR = join(import.meta.dirname, "../../src/tools");

function read(dir: string): { file: string; source: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, source: readFileSync(join(dir, file), "utf8") }));
}

/**
 * A behavioural test can only prove the inputs it happens to try. These static
 * checks hold for every input, which is the property PRD §17 actually asks for.
 */
describe("SQL construction safety", () => {
  const repositories = read(REPO_DIR);

  it("found at least five repository files to scan", () => {
    // Guards the scan itself: a glob that silently matched nothing would make
    // every check below pass vacuously.
    expect(repositories.length).toBeGreaterThanOrEqual(5);
  });

  it("interpolates nothing but module-level column constants into SQL text", () => {
    // Only the template passed to prepare() is SQL. Interpolation elsewhere --
    // building a bind value such as `${period}-%` -- is safe and must not be
    // flagged, so the scan is scoped to the prepare() argument itself.
    let statementsChecked = 0;

    for (const { file, source } of repositories) {
      for (const match of source.matchAll(/\.prepare\(\s*`([\s\S]*?)`\s*\)/g)) {
        statementsChecked++;
        const sql = match[1];
        for (const interpolation of sql.matchAll(/\$\{([^}]*)\}/g)) {
          const expression = interpolation[1].trim();
          // ALL_CAPS identifiers are the shared column lists defined in-module.
          // Anything else would mean a runtime value reaching the SQL text.
          expect(
            expression,
            `${file} interpolates "${expression}" into SQL text`
          ).toMatch(/^[A-Z][A-Z0-9_]*$/);
        }
      }
    }

    // Guard against the scan silently matching nothing and passing vacuously.
    expect(statementsChecked).toBeGreaterThanOrEqual(10);
  });

  it("binds parameters on every prepared statement that takes input", () => {
    for (const { file, source } of repositories) {
      const prepareCount = (source.match(/\.prepare\(/g) ?? []).length;
      const bindCount = (source.match(/\.bind\(/g) ?? []).length;
      expect(bindCount, `${file} has ${prepareCount} prepare() but ${bindCount} bind()`)
        .toBeGreaterThanOrEqual(prepareCount);
    }
  });

  it("keeps raw SQL out of the tool layer entirely", () => {
    for (const { file, source } of read(TOOLS_DIR)) {
      expect(source, `${file} should not build SQL`).not.toMatch(
        /\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\.prepare\(/
      );
    }
  });

  it("performs no writes anywhere in the read path", () => {
    for (const { file, source } of [...repositories, ...read(TOOLS_DIR)]) {
      expect(source, `${file} must be read-only`).not.toMatch(
        /\b(INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|DROP|ALTER)\b/
      );
    }
  });
});

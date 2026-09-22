/**
 * Portability lint conformance test (plan §4.1 rules 1 and 2).
 *
 * Rule 1: no SQL outside packages/storage/src/adapters.
 * Rule 2: no adapter-specific column types in the canonical schema (packages/storage/src/schema).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFile, isScanned, type PortabilityViolation } from "../scripts/portability-lint.js";

const ROOT = resolve(import.meta.dirname, "../..");

const rules = (v: PortabilityViolation[]): string[] => v.map((x) => x.rule);

describe("isScanned", () => {
  it("scans TypeScript under package and app src, not tests, dist, tooling or config", () => {
    expect(isScanned("packages/orchestrator/src/run-loop.ts")).toBe(true);
    expect(isScanned("apps/server/src/routes/tasks.ts")).toBe(true);
    expect(isScanned("packages/core/src/task/task.test.ts")).toBe(false);
    expect(isScanned("packages/core/dist/index.js")).toBe(false);
    expect(isScanned("tooling/scripts/tdd-guard.ts")).toBe(false);
    expect(isScanned("packages/core/vitest.config.ts")).toBe(false);
    expect(isScanned("README.md")).toBe(false);
  });
});

describe("rule 1: no SQL outside adapters", () => {
  it("flags SQL statements in string and template literals outside the adapters directory", () => {
    const samples = [
      'const q = "SELECT id FROM tasks WHERE office_id = ?";',
      "const q = `INSERT INTO tasks (id) VALUES (${id})`;",
      "await db.run('DELETE FROM offices');",
      "const ddl = `CREATE TABLE offices (id TEXT PRIMARY KEY)`;",
      'const q = "update tasks set status = ? where id = ?";',
      'const q = "ALTER TABLE tasks ADD COLUMN x TEXT";',
    ];
    for (const src of samples) {
      const v = checkFile("packages/orchestrator/src/scheduler.ts", src);
      expect(rules(v), src).toEqual(["no-sql-outside-adapters"]);
      expect(v[0]?.line).toBe(1);
    }
  });

  it("reports the correct line in multi-line files and template literals", () => {
    const src = ["const a = 1;", "const q = `", "  SELECT *", "  FROM tasks", "`;"].join("\n");
    const v = checkFile("apps/server/src/x.ts", src);
    expect(v).toHaveLength(1);
    expect(v[0]?.line).toBe(3);
  });

  it("ignores SQL words in comments, identifiers and prose that is not a statement", () => {
    const samples = [
      "// we SELECT the best candidate here",
      "/* DELETE FROM the queue happens in the adapter */",
      "const selectFrom = pick(items);",
      'const label = "Select from the list";',
      'const msg = "update the table of contents";',
      'const t = "created table for the canvas";',
    ];
    for (const src of samples) {
      expect(checkFile("packages/core/src/x.ts", src), src).toEqual([]);
    }
  });

  it("allows SQL inside packages/storage/src/adapters", () => {
    const src = 'const q = "SELECT id FROM tasks";';
    expect(checkFile("packages/storage/src/adapters/sqlite/queries.ts", src)).toEqual([]);
    expect(checkFile("packages/storage/src/adapters/postgres/migrate.ts", src)).toEqual([]);
  });
});

describe("rule 2: portable canonical schema", () => {
  it("flags adapter-specific column types in packages/storage/src/schema", () => {
    for (const type of [
      "JSONB",
      "SERIAL",
      "BIGSERIAL",
      "TIMESTAMPTZ",
      "UUID",
      "NVARCHAR",
      "BYTEA",
      "AUTO_INCREMENT",
      "ENUM",
      "ARRAY",
    ]) {
      const src = `export const col = { name: "config", type: "${type}" };`;
      const v = checkFile("packages/storage/src/schema/tables.ts", src);
      expect(rules(v), type).toEqual(["portable-schema-types"]);
    }
  });

  it("accepts the portable types and does not apply the rule outside the schema directory", () => {
    const src = 'export const cols = ["TEXT", "INTEGER", "REAL", "BOOLEAN", "TIMESTAMP", "JSON"];';
    expect(checkFile("packages/storage/src/schema/tables.ts", src)).toEqual([]);
    expect(
      checkFile("packages/storage/src/adapters/postgres/types.ts", 'const t = "JSONB";'),
    ).toEqual([]);
    expect(checkFile("packages/core/src/x.ts", "crypto.randomUUID()")).toEqual([]);
  });
});

describe("repository", () => {
  it("wires the lint into pnpm lint and documents it", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["lint"]).toMatch(/lint:portability/);
    expect(pkg.scripts["lint:portability"]).toBeTruthy();
    expect(readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8")).toMatch(/portability-lint/);
  });
});

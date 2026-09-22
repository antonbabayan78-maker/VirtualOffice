import { describe, expect, it } from "vitest";
import { COLLECTION_NAMES } from "../relational/types.js";
import { CANONICAL_MIGRATIONS, CANONICAL_TABLES, MIGRATIONS_TABLE } from "./canonical.js";
import { COLUMN_TYPES, validateMigrations, type Migration } from "./types.js";

describe("canonical schema", () => {
  it("only uses portable column types", () => {
    expect(COLUMN_TYPES).toEqual(["text", "integer", "real", "boolean", "timestamp", "json"]);
    for (const table of CANONICAL_TABLES) {
      for (const col of table.columns)
        expect(COLUMN_TYPES, `${table.name}.${col.name}`).toContain(col.type);
    }
  });

  it("has one table per relational collection plus events, each with an id primary key and a data document", () => {
    const names = CANONICAL_TABLES.map((t) => t.name);
    for (const c of COLLECTION_NAMES) expect(names).toContain(c);
    expect(names).toContain("events");
    for (const table of CANONICAL_TABLES) {
      const pk = table.columns.filter((c) => c.primaryKey);
      expect(
        pk.map((c) => c.name),
        table.name,
      ).toEqual(["id"]);
      expect(
        table.columns.some((c) => c.name === "data" && c.type === "json"),
        table.name,
      ).toBe(true);
    }
  });

  it("promotes office_id as an indexed column on every office-scoped table", () => {
    for (const table of CANONICAL_TABLES) {
      if (table.name === "offices" || table.name === "skills") continue;
      expect(
        table.columns.some((c) => c.name === "office_id"),
        table.name,
      ).toBe(true);
      expect(
        (table.indexes ?? []).some((i) => i.columns.includes("office_id")),
        table.name,
      ).toBe(true);
    }
  });

  it("ships an initial migration that creates every canonical table and can drop them all", () => {
    expect(CANONICAL_MIGRATIONS[0]?.id).toBe("0001_initial");
    const created =
      CANONICAL_MIGRATIONS[0]?.up.filter((s) => s.op === "createTable").map((s) => s.table.name) ??
      [];
    expect(created.sort()).toEqual(CANONICAL_TABLES.map((t) => t.name).sort());
    const dropped =
      CANONICAL_MIGRATIONS[0]?.down.filter((s) => s.op === "dropTable").map((s) => s.name) ?? [];
    expect(dropped.sort()).toEqual(created.sort());
    expect(MIGRATIONS_TABLE.name).toBe("_vo_migrations");
    expect(validateMigrations(CANONICAL_MIGRATIONS)).toEqual([]);
  });
});

describe("validateMigrations", () => {
  const base: Migration = {
    id: "0002_add_notes",
    up: [
      { op: "addColumn", table: "tasks", column: { name: "notes", type: "text", nullable: true } },
    ],
    down: [{ op: "dropColumn", table: "tasks", column: "notes" }],
  };

  it("accepts a well-formed migration", () => {
    expect(validateMigrations([base])).toEqual([]);
  });

  it("rejects ids that are not NNNN_snake_case, duplicates and out-of-order ids", () => {
    expect(validateMigrations([{ ...base, id: "add-notes" }]).map((e) => e.path)).toEqual([
      "migrations[0].id",
    ]);
    expect(validateMigrations([base, base]).map((e) => e.message)).toEqual([
      expect.stringMatching(/duplicate/),
    ]);
    const earlier = { ...base, id: "0001_x" };
    expect(validateMigrations([base, earlier]).map((e) => e.message)).toEqual([
      expect.stringMatching(/ascending/),
    ]);
  });

  it("rejects non-snake_case identifiers and unknown column types", () => {
    const bad: Migration = {
      id: "0003_bad",
      up: [
        {
          op: "createTable",
          table: {
            name: "BadTable",
            columns: [
              { name: "id", type: "text", primaryKey: true },
              { name: "camelCase", type: "text" },
              { name: "x", type: "uuid" as never },
            ],
          },
        },
      ],
      down: [{ op: "dropTable", name: "BadTable" }],
    };
    const paths = validateMigrations([bad]).map((e) => e.path);
    expect(paths).toContain("migrations[0].up[0].table.name");
    expect(paths).toContain("migrations[0].up[0].table.columns[1].name");
    expect(paths).toContain("migrations[0].up[0].table.columns[2].type");
  });

  it("validates identifiers in every step kind", () => {
    const all: Migration = {
      id: "0005_all_ops",
      up: [
        { op: "createIndex", table: "tasks", index: { name: "tasks_x", columns: ["x"] } },
        { op: "dropIndex", table: "tasks", name: "tasks_x" },
        { op: "renameTable", from: "tasks", to: "jobs" },
        { op: "dropColumn", table: "jobs", column: "x" },
        { op: "data", name: "backfill", run: () => Promise.resolve() },
      ],
      down: [{ op: "renameTable", from: "jobs", to: "tasks" }],
    };
    expect(validateMigrations([all])).toEqual([]);
    const bad: Migration = {
      id: "0006_bad_ops",
      up: [
        { op: "createIndex", table: "Tasks", index: { name: "Bad-Index", columns: ["x"] } },
        { op: "dropIndex", table: "tasks", name: "Bad" },
        { op: "renameTable", from: "tasks", to: "Jobs" },
        { op: "dropColumn", table: "tasks", column: "camelCase" },
        { op: "dropTable", name: "Nope" },
        { op: "data", name: "  ", run: () => Promise.resolve() },
      ],
      down: [{ op: "dropTable", name: "x" }],
    };
    const paths = validateMigrations([bad]).map((e) => e.path);
    for (const expected of [
      "migrations[0].up[0].table",
      "migrations[0].up[0].index.name",
      "migrations[0].up[1].name",
      "migrations[0].up[2].to",
      "migrations[0].up[3].column",
      "migrations[0].up[4].name",
      "migrations[0].up[5].name",
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it("rejects an index that references a column the table does not have", () => {
    const m: Migration = {
      id: "0007_bad_index",
      up: [
        {
          op: "createTable",
          table: {
            name: "t",
            columns: [{ name: "id", type: "text", primaryKey: true }],
            indexes: [{ name: "t_missing", columns: ["missing"] }],
          },
        },
      ],
      down: [{ op: "dropTable", name: "t" }],
    };
    expect(validateMigrations([m]).map((e) => e.message)).toEqual([
      expect.stringMatching(/unknown column "missing"/),
    ]);
  });

  it("requires exactly one primary key column per created table and non-empty steps", () => {
    const noPk: Migration = {
      id: "0004_nopk",
      up: [{ op: "createTable", table: { name: "t", columns: [{ name: "a", type: "text" }] } }],
      down: [],
    };
    const errors = validateMigrations([noPk]);
    expect(errors.map((e) => e.path)).toContain("migrations[0].up[0].table");
    expect(errors.map((e) => e.path)).toContain("migrations[0].down");
  });
});

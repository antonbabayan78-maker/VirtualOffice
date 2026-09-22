import { describe, expect, it } from "vitest";
import { CANONICAL_MIGRATIONS } from "../../schema/canonical.js";
import type { Migration } from "../../schema/types.js";
import { DIALECTS, quoteIdentifier, renderMigration, renderStep, type Dialect } from "./dialect.js";

const sample: Migration = {
  id: "0009_sample",
  up: [
    {
      op: "createTable",
      table: {
        name: "widgets",
        columns: [
          { name: "id", type: "text", primaryKey: true },
          { name: "office_id", type: "text" },
          { name: "count", type: "integer", default: 0 },
          { name: "ratio", type: "real", nullable: true },
          { name: "enabled", type: "boolean", default: true },
          { name: "created_at", type: "timestamp" },
          { name: "label", type: "text", default: "it's" },
          { name: "data", type: "json" },
        ],
        indexes: [
          { name: "widgets_office_id", columns: ["office_id"] },
          { name: "widgets_label_unique", columns: ["office_id", "label"], unique: true },
        ],
      },
    },
    { op: "addColumn", table: "widgets", column: { name: "notes", type: "text", nullable: true } },
    { op: "createIndex", table: "widgets", index: { name: "widgets_count", columns: ["count"] } },
    { op: "renameTable", from: "widgets", to: "gadgets" },
  ],
  down: [
    { op: "renameTable", from: "gadgets", to: "widgets" },
    { op: "dropIndex", table: "widgets", name: "widgets_count" },
    { op: "dropColumn", table: "widgets", column: "notes" },
    { op: "dropTable", name: "widgets" },
  ],
};

describe("dialects", () => {
  it("lists the four supported dialects", () => {
    expect(DIALECTS).toEqual(["sqlite", "postgres", "mysql", "mssql"]);
  });

  it("quotes identifiers per dialect", () => {
    expect(quoteIdentifier("sqlite", "tasks")).toBe('"tasks"');
    expect(quoteIdentifier("postgres", "tasks")).toBe('"tasks"');
    expect(quoteIdentifier("mysql", "tasks")).toBe("`tasks`");
    expect(quoteIdentifier("mssql", "tasks")).toBe("[tasks]");
  });

  for (const dialect of DIALECTS) {
    it(`renders the sample migration for ${dialect} (snapshot)`, () => {
      expect(renderMigration(dialect, sample, "up")).toMatchSnapshot();
      expect(renderMigration(dialect, sample, "down")).toMatchSnapshot();
    });

    it(`renders the canonical initial migration for ${dialect} without adapter-specific types leaking into portable positions`, () => {
      const initial = CANONICAL_MIGRATIONS[0];
      if (!initial) throw new Error("no initial migration");
      const sql = renderMigration(dialect, initial, "up");
      expect(sql.length).toBeGreaterThan(9);
      expect(sql.every((s) => s.endsWith(";"))).toBe(true);
      expect(sql.some((s) => /CREATE TABLE .*tasks/.test(s))).toBe(true);
    });
  }

  it("maps every portable type per dialect", () => {
    const col = (type: "text" | "integer" | "real" | "boolean" | "timestamp" | "json"): string =>
      renderStep("postgres", { op: "addColumn", table: "t", column: { name: "c", type } })[0] ?? "";
    expect(col("json")).toContain("JSONB");
    expect(col("timestamp")).toContain("TIMESTAMPTZ");
    expect(
      renderStep("sqlite", { op: "addColumn", table: "t", column: { name: "c", type: "json" } })[0],
    ).toContain("TEXT");
    expect(
      renderStep("mysql", {
        op: "addColumn",
        table: "t",
        column: { name: "c", type: "boolean" },
      })[0],
    ).toContain("TINYINT(1)");
    expect(
      renderStep("mssql", { op: "addColumn", table: "t", column: { name: "c", type: "real" } })[0],
    ).toContain("FLOAT");
  });

  it("escapes string defaults and renders booleans per dialect", () => {
    const step = {
      op: "addColumn",
      table: "t",
      column: { name: "c", type: "text", default: "a'b" },
    } as const;
    for (const d of DIALECTS) expect(renderStep(d, step)[0]).toContain("'a''b'");
    const bool = {
      op: "addColumn",
      table: "t",
      column: { name: "c", type: "boolean", default: true },
    } as const;
    expect(renderStep("postgres", bool)[0]).toContain("DEFAULT TRUE");
    expect(renderStep("sqlite", bool)[0]).toContain("DEFAULT 1");
    expect(renderStep("mssql", bool)[0]).toContain("DEFAULT 1");
  });

  it("does not render data steps as SQL", () => {
    const step = { op: "data", name: "backfill", run: () => Promise.resolve() } as const;
    for (const d of DIALECTS as readonly Dialect[]) expect(renderStep(d, step)).toEqual([]);
  });
});

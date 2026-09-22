import { describe, expect, it } from "vitest";
import { InMemoryRelationalStore } from "../../relational/in-memory.js";
import { MIGRATIONS_TABLE } from "../../schema/canonical.js";
import type { Migration } from "../../schema/types.js";
import * as fx from "../../testing/fixtures.js";
import { MigrationRunner, type SqlExecutor } from "./runner.js";

/** Records SQL and tracks the migrations table in memory, no real database needed. */
class FakeExecutor implements SqlExecutor {
  readonly statements: string[] = [];
  readonly applied = new Map<string, Date>();

  exec(sql: string): Promise<void> {
    this.statements.push(sql);
    return Promise.resolve();
  }

  listApplied(): Promise<string[]> {
    return Promise.resolve([...this.applied.keys()].sort());
  }

  markApplied(id: string, at: Date): Promise<void> {
    this.applied.set(id, at);
    return Promise.resolve();
  }

  unmarkApplied(id: string): Promise<void> {
    this.applied.delete(id);
    return Promise.resolve();
  }
}

const m1: Migration = {
  id: "0001_a",
  up: [
    {
      op: "createTable",
      table: { name: "a", columns: [{ name: "id", type: "text", primaryKey: true }] },
    },
  ],
  down: [{ op: "dropTable", name: "a" }],
};
const m2: Migration = {
  id: "0002_b",
  up: [{ op: "addColumn", table: "a", column: { name: "b", type: "integer", nullable: true } }],
  down: [{ op: "dropColumn", table: "a", column: "b" }],
};
const now = () => new Date("2026-09-22T00:00:00Z");

describe("MigrationRunner", () => {
  it("applies pending migrations in order, rendering SQL for the dialect and recording each id", async () => {
    const db = new FakeExecutor();
    const runner = new MigrationRunner({
      dialect: "postgres",
      executor: db,
      migrations: [m1, m2],
      now,
    });
    expect(await runner.status()).toEqual({ applied: [], pending: ["0001_a", "0002_b"] });
    const result = await runner.up();
    expect(result.applied).toEqual(["0001_a", "0002_b"]);
    expect(db.statements.some((s) => s.startsWith('CREATE TABLE "a"'))).toBe(true);
    expect(db.statements.some((s) => s.startsWith('ALTER TABLE "a" ADD COLUMN "b"'))).toBe(true);
    expect(await runner.status()).toEqual({ applied: ["0001_a", "0002_b"], pending: [] });
  });

  it("is idempotent: a second up applies nothing", async () => {
    const db = new FakeExecutor();
    const runner = new MigrationRunner({
      dialect: "sqlite",
      executor: db,
      migrations: [m1, m2],
      now,
    });
    await runner.up();
    const count = db.statements.length;
    expect((await runner.up()).applied).toEqual([]);
    expect(db.statements).toHaveLength(count);
  });

  it("supports a target for partial up and steps down in reverse order", async () => {
    const db = new FakeExecutor();
    const runner = new MigrationRunner({
      dialect: "mysql",
      executor: db,
      migrations: [m1, m2],
      now,
    });
    expect((await runner.up({ to: "0001_a" })).applied).toEqual(["0001_a"]);
    expect((await runner.up()).applied).toEqual(["0002_b"]);
    const down = await runner.down({ steps: 1 });
    expect(down.reverted).toEqual(["0002_b"]);
    expect(db.statements.at(-1)).toBe("ALTER TABLE `a` DROP COLUMN `b`;");
    expect((await runner.down()).reverted).toEqual(["0001_a"]);
    expect(await runner.status()).toEqual({ applied: [], pending: ["0001_a", "0002_b"] });
  });

  it("round-trips up then down on every dialect, leaving the migrations table empty", async () => {
    for (const dialect of ["sqlite", "postgres", "mysql", "mssql"] as const) {
      const db = new FakeExecutor();
      const runner = new MigrationRunner({ dialect, executor: db, migrations: [m1, m2], now });
      await runner.up();
      await runner.down();
      expect(await db.listApplied(), dialect).toEqual([]);
      expect(
        db.statements.filter((s) => s.includes("DROP TABLE")),
        dialect,
      ).toHaveLength(1);
    }
  });

  it("refuses to run when the migration list is invalid or an applied id is unknown", async () => {
    const db = new FakeExecutor();
    expect(
      () =>
        new MigrationRunner({
          dialect: "sqlite",
          executor: db,
          migrations: [{ ...m1, id: "bad id" }],
          now,
        }),
    ).toThrow(/migrations\[0\]\.id/);
    await db.markApplied("0000_ghost", now());
    const runner = new MigrationRunner({ dialect: "sqlite", executor: db, migrations: [m1], now });
    await expect(runner.up()).rejects.toThrow(/0000_ghost/);
  });

  it("renders the migrations bookkeeping table for the dialect", () => {
    const db = new FakeExecutor();
    const runner = new MigrationRunner({ dialect: "mssql", executor: db, migrations: [], now });
    const ddl = runner.bootstrapSql();
    expect(ddl[0]).toContain(`[${MIGRATIONS_TABLE.name}]`);
  });

  it("runs data migrations through the repository layer, without SQL", async () => {
    const store = new InMemoryRelationalStore();
    await store.tasks.put(fx.task("t1", "o1", "d1", "old title"));
    const seen: string[] = [];
    const data: Migration = {
      id: "0003_retitle",
      up: [
        {
          op: "data",
          name: "retitle tasks",
          run: async (ctx) => {
            const page = await ctx.store.tasks.list();
            for (const t of page.items)
              await ctx.store.tasks.put({ ...t, title: t.title.toUpperCase() });
            seen.push("up");
          },
          revert: async (ctx) => {
            const page = await ctx.store.tasks.list();
            for (const t of page.items)
              await ctx.store.tasks.put({ ...t, title: t.title.toLowerCase() });
            seen.push("down");
          },
        },
      ],
      down: [],
    };
    const db = new FakeExecutor();
    const runner = new MigrationRunner({
      dialect: "sqlite",
      executor: db,
      migrations: [data],
      now,
      store,
    });
    await runner.up();
    expect((await store.tasks.get("t1"))?.title).toBe("OLD TITLE");
    await runner.down();
    expect((await store.tasks.get("t1"))?.title).toBe("old title");
    expect(seen).toEqual(["up", "down"]);
    expect(db.statements).toEqual([]);
  });

  it("fails a data step clearly when no store was provided", async () => {
    const data: Migration = {
      id: "0003_x",
      up: [{ op: "data", name: "x", run: () => Promise.resolve() }],
      down: [],
    };
    const runner = new MigrationRunner({
      dialect: "sqlite",
      executor: new FakeExecutor(),
      migrations: [data],
      now,
    });
    await expect(runner.up()).rejects.toThrow(/store/);
  });
});

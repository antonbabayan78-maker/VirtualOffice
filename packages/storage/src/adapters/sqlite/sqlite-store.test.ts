import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unwrap } from "@vo/core";
import { CANONICAL_TABLES } from "../../schema/canonical.js";
import { openStorage, parseStorageConfig, StorageRegistry } from "../../stores/registry.js";
import { memoryAdapterFactory } from "../../stores/in-memory.js";
import * as fx from "../../testing/fixtures.js";
import { relationalStoreContract } from "../../testing/relational-contract.js";
import {
  openSqliteStore,
  sqliteAdapterFactory,
  sqlitePathFromUrl,
  type SqliteRelationalStore,
} from "./sqlite-store.js";

relationalStoreContract("sqlite (:memory:)", {
  create: () => openSqliteStore({ path: ":memory:" }),
  destroy: (store) => store.close(),
});

describe("sqlitePathFromUrl", () => {
  it("maps URLs to file paths and the in-memory database", () => {
    expect(sqlitePathFromUrl(new URL("sqlite::memory:"))).toBe(":memory:");
    expect(sqlitePathFromUrl(new URL("sqlite:///tmp/office.db"))).toBe("/tmp/office.db");
    expect(sqlitePathFromUrl(new URL("sqlite:./data/office.db"))).toBe("./data/office.db");
  });
});

describe("SqliteRelationalStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "vo-sqlite-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs the canonical migrations on open and reports them applied", async () => {
    const store = await openSqliteStore({ path: ":memory:" });
    expect(await store.tables()).toEqual(
      expect.arrayContaining([...CANONICAL_TABLES.map((t) => t.name), "_vo_migrations"]),
    );
    expect(await store.migrationStatus()).toEqual({ applied: ["0001_initial"], pending: [] });
    await store.close();
  });

  it("migrates down and back up cleanly", async () => {
    const store = await openSqliteStore({ path: ":memory:" });
    await store.migrateDown();
    expect(await store.tables()).toEqual(["_vo_migrations"]);
    expect(await store.migrationStatus()).toEqual({ applied: [], pending: ["0001_initial"] });
    await store.migrateUp();
    expect(await store.tables()).toContain("tasks");
    await store.tasks.put(fx.task("t1", "o1", "d1"));
    expect(await store.tasks.count()).toBe(1);
    await store.close();
  });

  it("persists to a file and survives reopen", async () => {
    const path = join(dir, "office.db");
    const first = await openSqliteStore({ path });
    await first.offices.put(fx.office("o1", "Persisted"));
    await first.employees.put(fx.employee("e1", "o1", "d1"));
    await first.close();
    const second = await openSqliteStore({ path });
    expect((await second.offices.get("o1"))?.name).toBe("Persisted");
    expect(await second.employees.get("e1")).toEqual(fx.employee("e1", "o1", "d1"));
    expect(await second.migrationStatus()).toEqual({ applied: ["0001_initial"], pending: [] });
    await second.close();
  });

  it("filters and orders on non-promoted fields through the JSON document", async () => {
    const store = await openSqliteStore({ path: ":memory:" });
    await store.tasks.put({ ...fx.task("t1", "o1", "d1", "B"), tokenBudget: 10 });
    await store.tasks.put({ ...fx.task("t2", "o1", "d1", "A"), tokenBudget: 20 });
    await store.tasks.put({ ...fx.task("t3", "o1", "d1", "C"), tokenBudget: 10 });
    expect((await store.tasks.list({ where: { tokenBudget: 10 } })).items.map((t) => t.id)).toEqual(
      ["t1", "t3"],
    );
    expect(
      (await store.tasks.list({ orderBy: { field: "tokenBudget", direction: "desc" } })).items.map(
        (t) => t.id,
      ),
    ).toEqual(["t2", "t3", "t1"]);
    expect(await store.tasks.count({ tokenBudget: 10 })).toBe(2);
    await store.connectors.put(fx.connector("k1", "o1"));
    expect((await store.connectors.list({ where: { enabled: true } })).items).toHaveLength(1);
    expect((await store.connectors.list({ where: { enabled: false } })).items).toHaveLength(0);
    await store.close();
  });

  it("stores promoted columns so SQL-level filters work without reading documents", async () => {
    const store = await openSqliteStore({ path: ":memory:" });
    await store.tasks.put(fx.task("t1", "o1", "d1"));
    const row = store.debugRow("tasks", "t1");
    expect(row).toMatchObject({
      id: "t1",
      office_id: "o1",
      department_id: "d1",
      status: "backlog",
      priority: "high",
    });
    expect(typeof row?.["data"]).toBe("string");
    expect(row?.["created_at"]).toBe(fx.T0.toISOString());
    await store.close();
  });

  it("keeps concurrent writers consistent across many parallel puts and a transaction", async () => {
    const store: SqliteRelationalStore = await openSqliteStore({
      path: join(dir, "concurrent.db"),
    });
    await Promise.all([
      ...Array.from({ length: 200 }, (_, i) =>
        store.tasks.put(fx.task(`t${String(i)}`, "o1", "d1")),
      ),
      store.transaction(async (tx) => {
        await tx.offices.put(fx.office("o1"));
        await tx.offices.put(fx.office("o2"));
      }),
    ]);
    expect(await store.tasks.count()).toBe(200);
    expect(await store.offices.count()).toBe(2);
    await store.close();
  });

  it("is registered as the sqlite: scheme for the relational store", async () => {
    expect(sqliteAdapterFactory.scheme).toBe("sqlite");
    expect(sqliteAdapterFactory.supports).toEqual(["relational", "events", "vector"]);
    const registry = new StorageRegistry()
      .register(memoryAdapterFactory)
      .register(sqliteAdapterFactory);
    const cfg = unwrap(
      parseStorageConfig({
        relational: "sqlite::memory:",
        vector: "memory://v",
        events: "memory://e",
        coordination: "memory://c",
        blobs: "memory://b",
      }),
    );
    const storage = await registry.open(cfg);
    await storage.relational.offices.put(fx.office("o1"));
    expect(await storage.relational.offices.count()).toBe(1);
    await storage.close();
    const viaDefault = await openStorage({
      relational: "sqlite::memory:",
      vector: "memory://v",
      events: "memory://e",
      coordination: "memory://c",
      blobs: "memory://b",
    });
    await viaDefault.close();
  });
});

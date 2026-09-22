import { describe, expect, it } from "vitest";
import { relationalStoreContract } from "../../testing/relational-contract.js";
import * as fx from "../../testing/fixtures.js";
import { openSqliteStore } from "./sqlite-store.js";

// The whole contract must hold with the optional capabilities switched off.
relationalStoreContract("sqlite without jsonQuery and upsert", {
  create: () =>
    openSqliteStore({ path: ":memory:", capabilities: { jsonQuery: false, upsert: false } }),
  destroy: (store) => store.close(),
});

describe("SqliteRelationalStore capability fallbacks", () => {
  it("reports full capabilities by default and the reduced set when disabled", async () => {
    const full = await openSqliteStore({ path: ":memory:" });
    expect(full.capabilities).toMatchObject({
      transactions: true,
      jsonQuery: true,
      upsert: true,
      partitioning: false,
      vector: false,
      listenNotify: false,
    });
    await full.close();
    const reduced = await openSqliteStore({
      path: ":memory:",
      capabilities: { jsonQuery: false, upsert: false },
    });
    expect(reduced.capabilities).toMatchObject({
      jsonQuery: false,
      upsert: false,
      transactions: true,
    });
    await reduced.close();
  });

  it("filters, sorts and paginates on non-promoted fields in memory when jsonQuery is off", async () => {
    const store = await openSqliteStore({ path: ":memory:", capabilities: { jsonQuery: false } });
    for (let i = 0; i < 9; i++)
      await store.tasks.put({ ...fx.task(`t${String(i)}`, "o1", "d1"), tokenBudget: (i % 3) + 1 });
    expect(await store.tasks.count({ tokenBudget: 1 })).toBe(3);
    const desc = await store.tasks.list({
      where: { officeId: "o1" as never },
      orderBy: { field: "tokenBudget", direction: "desc" },
      limit: 4,
    });
    expect(desc.items.map((t) => t.tokenBudget)).toEqual([3, 3, 3, 2]);
    expect(desc.nextCursor).not.toBeNull();
    const next = await store.tasks.list({
      where: { officeId: "o1" as never },
      orderBy: { field: "tokenBudget", direction: "desc" },
      limit: 4,
      ...(desc.nextCursor === null ? {} : { cursor: desc.nextCursor }),
    });
    expect(next.items.map((t) => t.tokenBudget)).toEqual([2, 2, 1, 1]);
    expect(store.fallbackQueries).toBeGreaterThan(0);
    await store.close();
  });

  it("upserts through read-then-write when native upsert is off", async () => {
    const store = await openSqliteStore({ path: ":memory:", capabilities: { upsert: false } });
    await store.offices.put(fx.office("o1", "First"));
    await store.offices.put(fx.office("o1", "Second"));
    expect((await store.offices.get("o1"))?.name).toBe("Second");
    expect(await store.offices.count()).toBe(1);
    await store.close();
  });
});

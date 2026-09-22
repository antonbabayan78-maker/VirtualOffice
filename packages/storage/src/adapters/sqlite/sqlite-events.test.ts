import { describe, expect, it } from "vitest";
import { eventStoreContract } from "../../testing/event-contract.js";
import { openSqliteEventStore } from "./sqlite-events.js";

eventStoreContract("sqlite (bucketed tables)", {
  create: () => openSqliteEventStore({ path: ":memory:" }),
  destroy: (store) => store.close(),
});

describe("SqliteEventStore partitioning fallback", () => {
  it("reports no native partitioning and creates one table per month on demand", async () => {
    const store = await openSqliteEventStore({ path: ":memory:" });
    expect(store.capabilities.partitioning).toBe(false);
    expect(await store.bucketTables()).toEqual([]);
    await store.append([
      { id: "a", officeId: "o1", at: new Date("2026-09-22T10:00:00Z"), type: "t", payload: {} },
      { id: "b", officeId: "o1", at: new Date("2026-11-02T10:00:00Z"), type: "t", payload: {} },
    ]);
    expect(await store.bucketTables()).toEqual(["events_2026_09", "events_2026_11"]);
    expect(await store.count({ officeId: "o1" })).toBe(2);
    const page = await store.query({ officeId: "o1", from: new Date("2026-10-01T00:00:00Z") });
    expect(page.items.map((e) => e.id)).toEqual(["b"]);
    await store.close();
  });

  it("drops whole buckets cheaply, which is what retention needs", async () => {
    const store = await openSqliteEventStore({ path: ":memory:" });
    await store.append([
      { id: "a", officeId: "o1", at: new Date("2026-08-01T00:00:00Z"), type: "t", payload: {} },
      { id: "b", officeId: "o1", at: new Date("2026-09-01T00:00:00Z"), type: "t", payload: {} },
    ]);
    expect(await store.dropBucketsBefore(new Date("2026-09-01T00:00:00Z"))).toEqual(["2026_08"]);
    expect(await store.bucketTables()).toEqual(["events_2026_09"]);
    expect(await store.count({ officeId: "o1" })).toBe(1);
    await store.close();
  });
});

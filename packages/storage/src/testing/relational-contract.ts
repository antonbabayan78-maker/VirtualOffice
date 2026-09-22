/**
 * Relational store contract.
 *
 * Every RelationalStore adapter (in-memory, SQLite, Postgres, MySQL, ...) must pass
 * this suite unchanged. Adapter tests call `relationalStoreContract(name, factory)`.
 */
import type { OfficeId } from "@vo/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelationalStore } from "../relational/types.js";
import * as fx from "./fixtures.js";

export interface RelationalStoreFactory {
  /** A fresh, empty store. */
  create(): Promise<RelationalStore>;
  /** Release resources. */
  destroy(store: RelationalStore): Promise<void>;
}

export function relationalStoreContract(name: string, factory: RelationalStoreFactory): void {
  describe(`RelationalStore contract: ${name}`, () => {
    let store: RelationalStore;

    beforeEach(async () => {
      store = await factory.create();
    });

    afterEach(async () => {
      await factory.destroy(store);
    });

    describe("basic persistence", () => {
      it("get returns null for a missing id", async () => {
        expect(await store.offices.get("nope")).toBeNull();
      });

      it("round-trips every entity type deep-equal, including Date and nested objects", async () => {
        const o = fx.office("o1");
        const d = fx.department("d1", "o1");
        const e = fx.employee("e1", "o1", "d1");
        const t = fx.task("t1", "o1", "d1");
        const c = fx.connection("c1", "o1", "d1", "d2");
        const k = fx.connector("k1", "o1");
        const s = fx.skill("tdd");
        const m = fx.memory("m1", "o1", "e1");
        const snap = fx.snapshot("snap-1", "o1");
        await store.snapshots.put(snap);
        await store.offices.put(o);
        await store.departments.put(d);
        await store.employees.put(e);
        await store.tasks.put(t);
        await store.connections.put(c);
        await store.connectors.put(k);
        await store.skills.put(s);
        await store.memories.put(m);

        expect(await store.offices.get(o.id)).toEqual(o);
        expect(await store.departments.get(d.id)).toEqual(d);
        expect(await store.employees.get(e.id)).toEqual(e);
        expect(await store.tasks.get(t.id)).toEqual(t);
        expect(await store.connections.get(c.id)).toEqual(c);
        expect(await store.connectors.get(k.id)).toEqual(k);
        expect(await store.skills.get(s.id)).toEqual(s);
        expect(await store.memories.get(m.id)).toEqual(m);
        expect(await store.snapshots.get(snap.id)).toEqual(snap);

        const back = await store.offices.get(o.id);
        expect(back?.createdAt).toBeInstanceOf(Date);
        expect((await store.memories.get(m.id))?.expiresAt).toBeInstanceOf(Date);
      });

      it("put is an upsert", async () => {
        await store.offices.put(fx.office("o1", "First"));
        await store.offices.put(fx.office("o1", "Second"));
        expect((await store.offices.get("o1"))?.name).toBe("Second");
        expect(await store.offices.count()).toBe(1);
      });

      it("returned entities are detached copies", async () => {
        const o = fx.office("o1");
        await store.offices.put(o);
        const a = await store.offices.get(o.id);
        const b = await store.offices.get(o.id);
        expect(a).not.toBe(b);
        expect(a).not.toBe(o);
      });

      it("delete reports whether something was removed", async () => {
        await store.offices.put(fx.office("o1"));
        expect(await store.offices.delete("o1")).toBe(true);
        expect(await store.offices.delete("o1")).toBe(false);
        expect(await store.offices.get("o1")).toBeNull();
      });
    });

    describe("querying", () => {
      beforeEach(async () => {
        await store.offices.put(fx.office("o1"));
        await store.offices.put(fx.office("o2"));
        for (const [id, office] of [
          ["d1", "o1"],
          ["d2", "o1"],
          ["d3", "o2"],
        ] as const) {
          await store.departments.put(fx.department(id, office));
        }
        for (let i = 1; i <= 25; i++) {
          await store.tasks.put(
            fx.task(
              `t${String(i).padStart(2, "0")}`,
              i <= 20 ? "o1" : "o2",
              "d1",
              `Task ${String(i)}`,
            ),
          );
        }
      });

      it("filters by equality on top-level fields", async () => {
        const page = await store.departments.list({ where: { officeId: "o1" as OfficeId } });
        expect(page.items.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
        expect(page.nextCursor).toBeNull();
      });

      it("combines several where fields", async () => {
        const page = await store.tasks.list({
          where: { officeId: "o2" as OfficeId, status: "backlog" },
        });
        expect(page.items).toHaveLength(5);
        expect(
          (await store.tasks.list({ where: { officeId: "o2" as OfficeId, status: "done" } })).items,
        ).toHaveLength(0);
      });

      it("counts with and without a filter", async () => {
        expect(await store.tasks.count()).toBe(25);
        expect(await store.tasks.count({ officeId: "o1" as OfficeId })).toBe(20);
      });

      it("orders ascending and descending by a field, with id as a stable tiebreaker", async () => {
        const asc = await store.tasks.list({
          orderBy: { field: "title", direction: "asc" },
          limit: 3,
        });
        expect(asc.items.map((t) => t.title)).toEqual(["Task 1", "Task 10", "Task 11"]);
        const desc = await store.tasks.list({
          orderBy: { field: "title", direction: "desc" },
          limit: 2,
        });
        expect(desc.items.map((t) => t.title)).toEqual(["Task 9", "Task 8"]);
      });

      it("paginates with an opaque cursor without gaps or duplicates", async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
          const page = await store.tasks.list({
            where: { officeId: "o1" as OfficeId },
            orderBy: { field: "id", direction: "asc" },
            limit: 7,
            ...(cursor === null ? {} : { cursor }),
          });
          seen.push(...page.items.map((t) => t.id));
          cursor = page.nextCursor;
          pages += 1;
        } while (cursor !== null);
        expect(pages).toBe(3);
        expect(seen).toHaveLength(20);
        expect(new Set(seen).size).toBe(20);
        expect(seen).toEqual([...seen].sort());
      });

      it("defaults to ordering by id ascending and a bounded page size", async () => {
        const page = await store.tasks.list();
        expect(page.items.map((t) => t.id)).toEqual([...page.items.map((t) => t.id)].sort());
        expect(page.items.length).toBeLessThanOrEqual(store.maxPageSize);
      });

      it("rejects an invalid cursor", async () => {
        await expect(store.tasks.list({ cursor: "not-a-cursor" })).rejects.toThrow(/cursor/);
      });
    });

    describe("transactions", () => {
      it("commits all writes when the callback resolves", async () => {
        await store.transaction(async (tx) => {
          await tx.offices.put(fx.office("o1"));
          await tx.departments.put(fx.department("d1", "o1"));
        });
        expect(await store.offices.get("o1")).not.toBeNull();
        expect(await store.departments.get("d1")).not.toBeNull();
      });

      it("rolls back every write when the callback throws", async () => {
        await store.offices.put(fx.office("o0"));
        await expect(
          store.transaction(async (tx) => {
            await tx.offices.put(fx.office("o1"));
            await tx.offices.delete("o0");
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect(await store.offices.get("o1")).toBeNull();
        expect(await store.offices.get("o0")).not.toBeNull();
      });

      it("returns the callback's value", async () => {
        expect(await store.transaction(() => Promise.resolve(42))).toBe(42);
      });
    });

    describe("concurrency", () => {
      it("does not lose writes under parallel puts", async () => {
        await Promise.all(
          Array.from({ length: 100 }, (_, i) =>
            store.tasks.put(fx.task(`t${String(i)}`, "o1", "d1")),
          ),
        );
        expect(await store.tasks.count()).toBe(100);
      });
    });
  });
}

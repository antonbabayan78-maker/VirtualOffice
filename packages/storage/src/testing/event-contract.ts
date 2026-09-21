import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventStore, StoredEvent } from "../stores/types.js";

export interface EventStoreFactory {
  create(): Promise<EventStore>;
  destroy(store: EventStore): Promise<void>;
}

export function eventStoreContract(name: string, factory: EventStoreFactory): void {
  describe(`EventStore contract: ${name}`, () => {
    let store: EventStore;
    beforeEach(async () => {
      store = await factory.create();
    });
    afterEach(async () => {
      await factory.destroy(store);
    });

    const ev = (id: string, minute: number, type = "llm.call", officeId = "o1"): StoredEvent => ({
      id,
      officeId,
      at: new Date(Date.UTC(2026, 8, 22, 10, minute)),
      type,
      payload: { tokens: minute },
    });

    it("appends and queries in time order within an office", async () => {
      await store.append([ev("b", 2), ev("a", 1), ev("x", 1, "llm.call", "o2"), ev("c", 3)]);
      const page = await store.query({ officeId: "o1" });
      expect(page.items.map((e) => e.id)).toEqual(["a", "b", "c"]);
      expect(page.items[0]?.at).toBeInstanceOf(Date);
      expect(page.items[0]?.payload).toEqual({ tokens: 1 });
      expect(page.nextCursor).toBeNull();
    });

    it("filters by inclusive from / exclusive to and by type", async () => {
      await store.append([ev("a", 1), ev("b", 2, "tool.call"), ev("c", 3), ev("d", 4)]);
      const from = new Date(Date.UTC(2026, 8, 22, 10, 2));
      const to = new Date(Date.UTC(2026, 8, 22, 10, 4));
      expect((await store.query({ officeId: "o1", from, to })).items.map((e) => e.id)).toEqual([
        "b",
        "c",
      ]);
      expect(
        (await store.query({ officeId: "o1", type: "tool.call" })).items.map((e) => e.id),
      ).toEqual(["b"]);
      expect(await store.count({ officeId: "o1", from })).toBe(3);
      expect(await store.count({ officeId: "o1", type: "llm.call" })).toBe(3);
    });

    it("paginates with a cursor across equal timestamps without duplicates", async () => {
      await store.append(
        Array.from({ length: 12 }, (_, i) =>
          ev(`e${String(i).padStart(2, "0")}`, Math.floor(i / 4)),
        ),
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await store.query({
          officeId: "o1",
          limit: 5,
          ...(cursor === null ? {} : { cursor }),
        });
        seen.push(...page.items.map((e) => e.id));
        cursor = page.nextCursor;
      } while (cursor !== null);
      expect(seen).toHaveLength(12);
      expect(new Set(seen).size).toBe(12);
    });

    it("rejects an invalid cursor", async () => {
      await expect(store.query({ officeId: "o1", cursor: "nope" })).rejects.toThrow(/cursor/);
    });

    it("is append-only: appending an existing id is rejected and nothing is written", async () => {
      await store.append([ev("a", 1)]);
      await expect(store.append([ev("z", 9), ev("a", 5)])).rejects.toThrow(/duplicate/);
      expect(await store.count({ officeId: "o1" })).toBe(1);
    });
  });
}

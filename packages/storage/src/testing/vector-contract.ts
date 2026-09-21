import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VectorStore } from "../stores/types.js";

export interface VectorStoreFactory {
  create(): Promise<VectorStore>;
  destroy(store: VectorStore): Promise<void>;
}

export function vectorStoreContract(name: string, factory: VectorStoreFactory): void {
  describe(`VectorStore contract: ${name}`, () => {
    let store: VectorStore;
    beforeEach(async () => {
      store = await factory.create();
    });
    afterEach(async () => {
      await factory.destroy(store);
    });

    const rec = (
      id: string,
      vector: number[],
      ownerId = "emp-1",
      officeId = "o1",
    ): Parameters<VectorStore["upsert"]>[0][number] => ({
      id,
      officeId,
      scope: "employee",
      ownerId,
      vector,
      metadata: { kind: "fact" },
    });

    it("returns nearest neighbours by cosine similarity, highest first, limited to topK", async () => {
      await store.upsert([
        rec("a", [1, 0, 0]),
        rec("b", [0.9, 0.1, 0]),
        rec("c", [0, 1, 0]),
        rec("d", [0, 0, 1]),
      ]);
      const hits = await store.query({ officeId: "o1", vector: [1, 0, 0], topK: 2 });
      expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      expect(hits[1]?.score ?? 0).toBeLessThan(1);
      expect(hits[1]?.score ?? 0).toBeGreaterThan(0.9);
    });

    it("never returns vectors from another office", async () => {
      await store.upsert([rec("a", [1, 0, 0]), rec("x", [1, 0, 0], "emp-9", "o2")]);
      expect(
        (await store.query({ officeId: "o1", vector: [1, 0, 0], topK: 10 })).map((h) => h.id),
      ).toEqual(["a"]);
    });

    it("filters by scope and owner ids", async () => {
      await store.upsert([rec("a", [1, 0, 0], "emp-1"), rec("b", [1, 0, 0], "emp-2")]);
      const hits = await store.query({
        officeId: "o1",
        vector: [1, 0, 0],
        topK: 10,
        filter: { ownerIds: ["emp-2"] },
      });
      expect(hits.map((h) => h.id)).toEqual(["b"]);
      expect(
        await store.query({
          officeId: "o1",
          vector: [1, 0, 0],
          topK: 10,
          filter: { scope: "department" },
        }),
      ).toEqual([]);
    });

    it("upsert replaces an existing id and fixes the dimensionality on first write", async () => {
      await store.upsert([rec("a", [1, 0, 0])]);
      await store.upsert([rec("a", [0, 1, 0])]);
      expect(store.dimensions).toBe(3);
      const hits = await store.query({ officeId: "o1", vector: [0, 1, 0], topK: 1 });
      expect(hits[0]?.id).toBe("a");
      expect(hits[0]?.score).toBeCloseTo(1, 5);
      await expect(store.upsert([rec("z", [1, 0])])).rejects.toThrow(/dimension/);
      await expect(store.query({ officeId: "o1", vector: [1, 0], topK: 1 })).rejects.toThrow(
        /dimension/,
      );
    });

    it("deletes by id and by owner, reporting counts", async () => {
      await store.upsert([
        rec("a", [1, 0, 0], "emp-1"),
        rec("b", [1, 0, 0], "emp-1"),
        rec("c", [1, 0, 0], "emp-2"),
      ]);
      expect(await store.delete(["a", "missing"])).toBe(1);
      expect(await store.deleteByOwner("o1", "emp-1")).toBe(1);
      expect(
        (await store.query({ officeId: "o1", vector: [1, 0, 0], topK: 10 })).map((h) => h.id),
      ).toEqual(["c"]);
    });

    it("returns metadata with hits and an empty list on an empty store", async () => {
      expect(await store.query({ officeId: "o1", vector: [1, 0, 0], topK: 5 })).toEqual([]);
      await store.upsert([rec("a", [1, 0, 0])]);
      expect(
        (await store.query({ officeId: "o1", vector: [1, 0, 0], topK: 5 }))[0]?.metadata,
      ).toEqual({ kind: "fact" });
    });
  });
}

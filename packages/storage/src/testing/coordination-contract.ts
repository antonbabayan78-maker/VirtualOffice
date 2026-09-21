import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoordinationStore } from "../stores/types.js";

export interface CoordinationStoreFactory {
  /** The store must read time from `clock` so ttl tests are deterministic. */
  create(clock: () => number): Promise<CoordinationStore>;
  destroy(store: CoordinationStore): Promise<void>;
}

export function coordinationStoreContract(name: string, factory: CoordinationStoreFactory): void {
  describe(`CoordinationStore contract: ${name}`, () => {
    let store: CoordinationStore;
    let now = 1_000_000;
    beforeEach(async () => {
      now = 1_000_000;
      store = await factory.create(() => now);
    });
    afterEach(async () => {
      await factory.destroy(store);
    });

    it("gets, sets and deletes string values", async () => {
      expect(await store.get("k")).toBeNull();
      await store.set("k", "v");
      expect(await store.get("k")).toBe("v");
      expect(await store.delete("k")).toBe(true);
      expect(await store.delete("k")).toBe(false);
    });

    it("expires values after their ttl", async () => {
      await store.set("k", "v", 500);
      now += 499;
      expect(await store.get("k")).toBe("v");
      now += 1;
      expect(await store.get("k")).toBeNull();
    });

    it("increments atomically with an optional ttl (rate limiter primitive)", async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, () => store.incr("rpm", 1, 60_000)),
      );
      expect(Math.max(...results)).toBe(50);
      expect(await store.incr("rpm", 5)).toBe(55);
      now += 60_000;
      expect(await store.incr("rpm", 1)).toBe(1);
    });

    it("locks are exclusive, owner-bound and expire", async () => {
      expect(await store.acquireLock("scheduler", 1_000, "worker-a")).toBe(true);
      expect(await store.acquireLock("scheduler", 1_000, "worker-b")).toBe(false);
      expect(await store.acquireLock("scheduler", 1_000, "worker-a")).toBe(true); // re-entrant for the owner
      expect(await store.releaseLock("scheduler", "worker-b")).toBe(false);
      expect(await store.releaseLock("scheduler", "worker-a")).toBe(true);
      expect(await store.acquireLock("scheduler", 1_000, "worker-b")).toBe(true);
      now += 1_000;
      expect(await store.acquireLock("scheduler", 1_000, "worker-c")).toBe(true);
    });
  });
}

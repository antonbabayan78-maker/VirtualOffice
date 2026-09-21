import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlobStore } from "../stores/types.js";

export interface BlobStoreFactory {
  create(): Promise<BlobStore>;
  destroy(store: BlobStore): Promise<void>;
}

export function blobStoreContract(name: string, factory: BlobStoreFactory): void {
  describe(`BlobStore contract: ${name}`, () => {
    let store: BlobStore;
    beforeEach(async () => {
      store = await factory.create();
    });
    afterEach(async () => {
      await factory.destroy(store);
    });

    const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

    it("puts, gets and deletes bytes with a content type", async () => {
      expect(await store.get("o1/artifacts/a.txt")).toBeNull();
      await store.put("o1/artifacts/a.txt", bytes("hello"), "text/plain");
      const got = await store.get("o1/artifacts/a.txt");
      expect(got?.contentType).toBe("text/plain");
      expect(new TextDecoder().decode(got?.data)).toBe("hello");
      expect(await store.exists("o1/artifacts/a.txt")).toBe(true);
      expect(await store.delete("o1/artifacts/a.txt")).toBe(true);
      expect(await store.delete("o1/artifacts/a.txt")).toBe(false);
      expect(await store.exists("o1/artifacts/a.txt")).toBe(false);
    });

    it("overwrites on put and returns detached bytes", async () => {
      const data = bytes("one");
      await store.put("k", data);
      data[0] = 0;
      await store.put("k", bytes("two"));
      const got = await store.get("k");
      expect(new TextDecoder().decode(got?.data)).toBe("two");
      expect(got?.contentType).toBeNull();
    });

    it("lists keys by prefix in sorted order", async () => {
      await store.put("o1/a", bytes("1"));
      await store.put("o1/b/c", bytes("2"));
      await store.put("o2/a", bytes("3"));
      expect(await store.list("o1/")).toEqual(["o1/a", "o1/b/c"]);
      expect(await store.list("o9/")).toEqual([]);
    });

    it("rejects empty keys and keys with path traversal", async () => {
      for (const key of ["", "../x", "a/../b", "/abs"]) {
        await expect(store.put(key, bytes("x")), key).rejects.toThrow(/key/);
      }
    });

    it("handles large binary payloads byte-for-byte", async () => {
      const big = new Uint8Array(1_000_000).map((_, i) => i % 251);
      await store.put("big", big, "application/octet-stream");
      const got = await store.get("big");
      expect(got?.data.byteLength).toBe(1_000_000);
      expect(got?.data[999_999]).toBe(999_999 % 251);
    });
  });
}

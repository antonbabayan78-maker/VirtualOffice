import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vectorStoreContract } from "../../testing/vector-contract.js";
import { openSqliteVectorStore } from "./sqlite-vectors.js";

vectorStoreContract("sqlite (brute-force cosine)", {
  create: () => openSqliteVectorStore({ path: ":memory:" }),
  destroy: (store) => store.close(),
});

describe("SqliteVectorStore vector fallback", () => {
  it("reports no native vector index and persists vectors in a table", async () => {
    const store = await openSqliteVectorStore({ path: ":memory:" });
    expect(store.capabilities.vector).toBe(false);
    await store.upsert([
      { id: "a", officeId: "o1", scope: "employee", ownerId: "e1", vector: [0.6, 0.8] },
    ]);
    expect(store.dimensions).toBe(2);
    expect(await store.size()).toBe(1);
    await store.close();
  });

  it("remembers dimensions across reopen of the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vo-vec-"));
    try {
      const path = join(dir, "v.db");
      const a = await openSqliteVectorStore({ path });
      await a.upsert([
        { id: "a", officeId: "o1", scope: "employee", ownerId: "e1", vector: [1, 0, 0] },
      ]);
      await a.close();
      const b = await openSqliteVectorStore({ path });
      expect(b.dimensions).toBe(3);
      await expect(
        b.upsert([{ id: "z", officeId: "o1", scope: "employee", ownerId: "e1", vector: [1, 0] }]),
      ).rejects.toThrow(/dimension/);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

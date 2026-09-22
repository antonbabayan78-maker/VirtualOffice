import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unwrap } from "@vo/core";
import { memoryAdapterFactory } from "../../stores/in-memory.js";
import { openStorage, parseStorageConfig, StorageRegistry } from "../../stores/registry.js";
import { blobStoreContract } from "../../testing/blob-contract.js";
import {
  fileAdapterFactory,
  FsBlobStore,
  fsRootFromUrl,
  openFsBlobStore,
} from "./fs-blob-store.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vo-blobs-"));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

blobStoreContract("filesystem", {
  create: () => openFsBlobStore({ root: tempDir() }),
  destroy: (store) => store.close(),
});

describe("fsRootFromUrl", () => {
  it("maps file URLs to directories", () => {
    expect(fsRootFromUrl(new URL("file:///var/vo/blobs"))).toBe("/var/vo/blobs");
    expect(fsRootFromUrl(new URL("file:///var/vo/blobs%20dir"))).toBe("/var/vo/blobs dir");
    expect(() => fsRootFromUrl(new URL("file://host/share"))).toThrow(/local/);
  });
});

describe("FsBlobStore", () => {
  it("creates the root on open and lays out data and metadata under it", async () => {
    const root = join(tempDir(), "nested", "blobs");
    const store = await openFsBlobStore({ root });
    expect(existsSync(root)).toBe(true);
    await store.put("o1/tasks/t1/report.md", new TextEncoder().encode("# hi"), "text/markdown");
    expect(readFileSync(join(root, "data", "o1", "tasks", "t1", "report.md"), "utf8")).toBe("# hi");
    const meta = JSON.parse(
      readFileSync(join(root, "meta", "o1", "tasks", "t1", "report.md.json"), "utf8"),
    ) as { contentType: string; size: number };
    expect(meta).toEqual({ contentType: "text/markdown", size: 4 });
    await store.close();
  });

  it("persists across reopen and leaves no temp files behind", async () => {
    const root = tempDir();
    const a = await openFsBlobStore({ root });
    await a.put("k/one", new Uint8Array([1, 2, 3]));
    await a.put("k/one", new Uint8Array([9]));
    await a.close();
    const b = await openFsBlobStore({ root });
    expect(Array.from((await b.get("k/one"))?.data ?? [])).toEqual([9]);
    expect((await b.get("k/one"))?.contentType).toBeNull();
    expect(readdirSync(join(root, "data", "k")).filter((f) => f.includes(".tmp"))).toEqual([]);
    await b.close();
  });

  it("delete removes data and metadata, and list ignores directories", async () => {
    const store = await openFsBlobStore({ root: tempDir() });
    await store.put("a/b/c", new Uint8Array([1]), "x/y");
    await store.put("a/d", new Uint8Array([2]));
    expect(await store.list("a/")).toEqual(["a/b/c", "a/d"]);
    expect(await store.delete("a/b/c")).toBe(true);
    expect(await store.list("a/")).toEqual(["a/d"]);
    expect(await store.get("a/b/c")).toBeNull();
    await store.close();
  });

  it("is registered as the file: scheme for blobs", async () => {
    expect(fileAdapterFactory.scheme).toBe("file");
    expect(fileAdapterFactory.supports).toEqual(["blobs"]);
    const root = tempDir();
    const registry = new StorageRegistry()
      .register(memoryAdapterFactory)
      .register(fileAdapterFactory);
    const cfg = unwrap(
      parseStorageConfig({
        relational: "memory://r",
        vector: "memory://v",
        events: "memory://e",
        coordination: "memory://c",
        blobs: `file://${root}`,
      }),
    );
    const storage = await registry.open(cfg);
    expect(storage.blobs).toBeInstanceOf(FsBlobStore);
    await storage.blobs.put("x", new Uint8Array([1]));
    expect(existsSync(join(root, "data", "x"))).toBe(true);
    await storage.close();
    const viaDefault = await openStorage({
      ...Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, v.href])),
      blobs: `file://${root}`,
    });
    expect(viaDefault.blobs).toBeInstanceOf(FsBlobStore);
    await viaDefault.close();
  });
});

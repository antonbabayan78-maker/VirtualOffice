import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "@vo/core";
import { InMemoryRelationalStore } from "../relational/in-memory.js";
import * as fx from "../testing/fixtures.js";
import { memoryAdapterFactory } from "./in-memory.js";
import {
  openStorage,
  parseStorageConfig,
  StorageRegistry,
  STORE_KINDS,
  type AdapterFactory,
} from "./registry.js";

const allMemory = {
  relational: "memory://main",
  vector: "memory://vectors",
  events: "memory://events",
  coordination: "memory://coord",
  blobs: "memory://blobs",
};

describe("parseStorageConfig", () => {
  it("lists the five store kinds", () => {
    expect(STORE_KINDS).toEqual(["relational", "vector", "events", "coordination", "blobs"]);
  });

  it("accepts five parseable URLs", () => {
    const cfg = unwrap(parseStorageConfig(allMemory));
    expect(cfg.relational.protocol).toBe("memory:");
    expect(cfg.blobs.href).toBe("memory://blobs");
  });

  it("reports every missing or malformed URL", () => {
    const r = parseStorageConfig({ relational: "memory://main", vector: "not a url", blobs: 7 });
    expect(isErr(r)).toBe(true);
    if (isErr(r))
      expect(r.error.map((e) => e.path).sort()).toEqual([
        "blobs",
        "coordination",
        "events",
        "vector",
      ]);
    expect(isErr(parseStorageConfig(null))).toBe(true);
  });
});

describe("StorageRegistry", () => {
  it("opens five independent stores from URLs and closes them together", async () => {
    const registry = new StorageRegistry().register(memoryAdapterFactory);
    const storage = await registry.open(unwrap(parseStorageConfig(allMemory)));
    expect(storage.relational).toBeInstanceOf(InMemoryRelationalStore);
    await storage.relational.offices.put(fx.office("o1"));
    await storage.vector.upsert([
      { id: "v1", officeId: "o1", scope: "employee", ownerId: "e1", vector: [1, 0] },
    ]);
    await storage.events.append([
      { id: "ev1", officeId: "o1", at: fx.T0, type: "llm.call", payload: {} },
    ]);
    await storage.coordination.set("k", "v");
    await storage.blobs.put("o1/a", new Uint8Array([1]));
    expect(await storage.relational.offices.count()).toBe(1);
    expect((await storage.vector.query({ officeId: "o1", vector: [1, 0], topK: 1 }))[0]?.id).toBe(
      "v1",
    );
    expect(await storage.events.count({ officeId: "o1" })).toBe(1);
    expect(await storage.coordination.get("k")).toBe("v");
    expect(await storage.blobs.exists("o1/a")).toBe(true);
    await storage.close();
  });

  it("fails clearly on an unknown scheme, naming the store", async () => {
    const registry = new StorageRegistry().register(memoryAdapterFactory);
    const cfg = unwrap(parseStorageConfig({ ...allMemory, vector: "qdrant://localhost:6333" }));
    await expect(registry.open(cfg)).rejects.toThrow(/vector store: no adapter for "qdrant:"/);
  });

  it("fails when a scheme exists but does not support the requested store kind", async () => {
    const blobOnly: AdapterFactory = {
      scheme: "file",
      supports: ["blobs"],
      create: () => Promise.reject(new Error("should not be called")),
    };
    const registry = new StorageRegistry().register(memoryAdapterFactory).register(blobOnly);
    const cfg = unwrap(parseStorageConfig({ ...allMemory, vector: "file:///tmp/vectors" }));
    await expect(registry.open(cfg)).rejects.toThrow(/file:.*does not support vector/);
  });

  it("closes already-opened stores when a later adapter fails to open", async () => {
    const closed: string[] = [];
    class ClosingStore extends InMemoryRelationalStore {
      override close(): Promise<void> {
        closed.push("relational");
        return Promise.resolve();
      }
    }
    const flaky: AdapterFactory = {
      scheme: "flaky",
      supports: ["relational", "blobs"],
      create: (kind) =>
        kind === "blobs"
          ? Promise.reject(new Error("blob backend down"))
          : Promise.resolve(new ClosingStore() as never),
    };
    const registry = new StorageRegistry().register(memoryAdapterFactory).register(flaky);
    const cfg = unwrap(
      parseStorageConfig({ ...allMemory, relational: "flaky://main", blobs: "flaky://blobs" }),
    );
    await expect(registry.open(cfg)).rejects.toThrow(/blob backend down/);
    expect(closed).toEqual(["relational"]);
  });

  it("openStorage throws a readable error for invalid config", async () => {
    await expect(openStorage({ relational: 1 })).rejects.toThrow(
      /invalid storage config: relational: must be a connection URL/,
    );
  });

  it("rejects registering the same scheme twice", () => {
    const registry = new StorageRegistry().register(memoryAdapterFactory);
    expect(() => registry.register(memoryAdapterFactory)).toThrow(/memory/);
  });

  it("openStorage is a convenience over the default registry (memory adapters built in)", async () => {
    const storage = await openStorage(allMemory);
    await storage.coordination.set("x", "1");
    expect(await storage.coordination.get("x")).toBe("1");
    await storage.close();
  });

  it("a mixed setup runs an end-to-end office slice: entities, memory vectors, usage events, a lock and an artifact", async () => {
    const storage = await openStorage({
      ...allMemory,
      relational: "memory://a",
      vector: "memory://b",
    });
    const office = fx.office("o1");
    const dept = fx.department("d1", "o1");
    const emp = fx.employee("e1", "o1", "d1");
    const task = fx.task("t1", "o1", "d1");
    await storage.relational.transaction(async (tx) => {
      await tx.offices.put(office);
      await tx.departments.put(dept);
      await tx.employees.put(emp);
      await tx.tasks.put(task);
    });
    await storage.vector.upsert([
      { id: "m1", officeId: "o1", scope: "employee", ownerId: "e1", vector: [0.2, 0.8] },
    ]);
    await storage.events.append([
      {
        id: "u1",
        officeId: "o1",
        at: fx.T0,
        type: "llm.call",
        payload: { employeeId: "e1", tokens: 120 },
      },
    ]);
    expect(await storage.coordination.acquireLock("office:o1:scheduler", 5_000, "worker-1")).toBe(
      true,
    );
    await storage.blobs.put("o1/t1/report.md", new TextEncoder().encode("# done"), "text/markdown");

    expect(
      (await storage.relational.tasks.list({ where: { departmentId: dept.id } })).items,
    ).toHaveLength(1);
    expect(
      (await storage.vector.query({ officeId: "o1", vector: [0.1, 0.9], topK: 1 }))[0]?.id,
    ).toBe("m1");
    expect((await storage.events.query({ officeId: "o1" })).items[0]?.payload).toEqual({
      employeeId: "e1",
      tokens: 120,
    });
    expect(await storage.blobs.list("o1/t1/")).toEqual(["o1/t1/report.md"]);
    await storage.close();
  });
});

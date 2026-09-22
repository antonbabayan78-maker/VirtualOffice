import { describe, expect, it } from "vitest";
import { isEmptyDiff, type OfficeId } from "@vo/core";
import { InMemoryRelationalStore } from "../relational/in-memory.js";
import type { RelationalStore } from "../relational/types.js";
import { openSqliteStore } from "../adapters/sqlite/sqlite-store.js";
import * as fx from "../testing/fixtures.js";
import {
  listSnapshots,
  OfficeConfigService,
  readOfficeConfig,
  restoreSnapshot,
  takeSnapshot,
  type SnapshotId,
} from "./snapshots.js";

const t = (n: number): Date => new Date(Date.UTC(2026, 8, 22, 0, n));
function mustGet<T>(value: T | null): T {
  if (value === null) throw new Error("expected a value");
  return value;
}
let counter = 0;
const deps = () => ({ id: () => `snap-${String(++counter)}` as SnapshotId, now: () => t(counter) });

async function seed(store: RelationalStore): Promise<void> {
  await store.offices.put(fx.office("o1"));
  await store.departments.put(fx.department("d1", "o1", "Engineering"));
  await store.departments.put(fx.department("d2", "o1", "Sales"));
  await store.employees.put(fx.employee("e1", "o1", "d1"));
  await store.connections.put(fx.connection("c1", "o1", "d1", "d2"));
  await store.connectors.put(fx.connector("k1", "o1"));
  // Another office and runtime data must never leak into a snapshot.
  await store.offices.put(fx.office("o2"));
  await store.departments.put(fx.department("d9", "o2"));
  await store.tasks.put(fx.task("t1", "o1", "d1"));
  await store.memories.put(fx.memory("m1", "o1", "e1"));
}

const backends: [string, () => Promise<RelationalStore>][] = [
  ["in-memory", () => Promise.resolve(new InMemoryRelationalStore())],
  ["sqlite", () => openSqliteStore({ path: ":memory:" })],
];

for (const [name, open] of backends) {
  describe(`config snapshots on ${name}`, () => {
    it("readOfficeConfig collects exactly the office's configuration entities", async () => {
      const store = await open();
      await seed(store);
      const config = await readOfficeConfig(store, "o1" as OfficeId);
      expect(config.office.id).toBe("o1");
      expect(config.departments.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
      expect(config.employees.map((e) => e.id)).toEqual(["e1"]);
      expect(config.connections.map((c) => c.id)).toEqual(["c1"]);
      expect(config.connectors.map((c) => c.id)).toEqual(["k1"]);
      await expect(readOfficeConfig(store, "nope" as OfficeId)).rejects.toThrow(/office "nope"/);
      await store.close();
    });

    it("takeSnapshot persists the config with the office version and a reason", async () => {
      const store = await open();
      await seed(store);
      const snap = await takeSnapshot(store, "o1" as OfficeId, "initial", deps());
      expect(snap).toMatchObject({ officeId: "o1", version: 1, reason: "initial" });
      expect(snap.config.departments).toHaveLength(2);
      expect(await store.snapshots.get(snap.id)).toEqual(snap);
      const listed = await listSnapshots(store, "o1" as OfficeId);
      expect(listed.map((s) => s.id)).toEqual([snap.id]);
      await store.close();
    });

    it("OfficeConfigService snapshots on every change with an incrementing version, atomically", async () => {
      const store = await open();
      await seed(store);
      const service = new OfficeConfigService(store, deps());
      await service.applyChange("o1" as OfficeId, "rename engineering", async (tx) => {
        const d = mustGet(await tx.departments.get("d1"));
        await tx.departments.put({ ...d, name: "Platform" });
      });
      await service.applyChange("o1" as OfficeId, "add marketing", async (tx) => {
        await tx.departments.put(fx.department("d3", "o1", "Marketing"));
      });
      await expect(
        service.applyChange("o1" as OfficeId, "explodes", async (tx) => {
          await tx.departments.put(fx.department("d4", "o1", "Ghost"));
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const snaps = await listSnapshots(store, "o1" as OfficeId);
      expect(snaps.map((s) => [s.version, s.reason])).toEqual([
        [3, "add marketing"],
        [2, "rename engineering"],
      ]);
      expect((await store.offices.get("o1"))?.configVersion).toBe(3);
      expect(await store.departments.get("d4")).toBeNull();
      expect((await store.departments.get("d1"))?.name).toBe("Platform");
      await store.close();
    });

    it("restoreSnapshot round-trips: config after restore equals the snapshot (new version), and later additions are removed", async () => {
      const store = await open();
      await seed(store);
      const service = new OfficeConfigService(store, deps());
      const original = await takeSnapshot(store, "o1" as OfficeId, "baseline", deps());

      await service.applyChange("o1" as OfficeId, "mutate", async (tx) => {
        const d = mustGet(await tx.departments.get("d1"));
        await tx.departments.put({ ...d, color: "#ff0000" });
        await tx.departments.put(fx.department("d3", "o1", "Marketing"));
        await tx.employees.put(fx.employee("e2", "o1", "d3"));
        await tx.connectors.delete("k1");
      });
      expect(isEmptyDiff(await service.diffAgainstCurrent(original))).toBe(false);

      const restored = await restoreSnapshot(store, original, deps());
      const current = await readOfficeConfig(store, "o1" as OfficeId);
      expect(current.office.configVersion).toBe(3);
      expect({
        ...current,
        office: { ...current.office, configVersion: original.config.office.configVersion },
      }).toEqual(original.config);
      expect(restored.version).toBe(3);
      expect(restored.reason).toMatch(/restore .*baseline/);
      expect(await store.departments.get("d3")).toBeNull();
      expect(await store.employees.get("e2")).toBeNull();
      expect(await store.connectors.get("k1")).not.toBeNull();
      // Runtime data and other offices are untouched.
      expect(await store.tasks.get("t1")).not.toBeNull();
      expect(await store.departments.get("d9")).not.toBeNull();
      await store.close();
    });

    it("refuses to restore a snapshot from another office", async () => {
      const store = await open();
      await seed(store);
      const snap = await takeSnapshot(store, "o2" as OfficeId, "x", deps());
      await expect(
        restoreSnapshot(store, { ...snap, officeId: "o1" as OfficeId }, deps()),
      ).rejects.toThrow(/belongs to office/);
      await store.close();
    });
  });
}

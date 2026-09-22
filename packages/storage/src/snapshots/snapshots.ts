/**
 * Office configuration snapshots over the repository layer: read the current
 * configuration, persist a snapshot, list history, restore, and a service that
 * bumps configVersion and snapshots on every change, all inside one transaction.
 */
import {
  diffOfficeConfig,
  type ConfigDiff,
  type OfficeConfig,
  type OfficeId,
  type OfficeSnapshot,
  type SnapshotId,
} from "@vo/core";
import type {
  Entity,
  EntityRepository,
  RelationalCollections,
  RelationalStore,
} from "../relational/types.js";

export type { SnapshotId };

export interface SnapshotDeps {
  readonly id: () => SnapshotId;
  readonly now: () => Date;
}

const PAGE = 200;

async function allWhere<T extends Entity>(
  repo: EntityRepository<T>,
  where: Partial<T>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await repo.list({
      where,
      orderBy: { field: "id", direction: "asc" },
      limit: PAGE,
      ...(cursor === null ? {} : { cursor }),
    });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return out;
}

export async function readOfficeConfig(
  store: RelationalCollections,
  officeId: OfficeId,
): Promise<OfficeConfig> {
  const office = await store.offices.get(officeId);
  if (!office) throw new Error(`office "${officeId}" not found`);
  const [departments, employees, connections, connectors] = await Promise.all([
    allWhere(store.departments, { officeId }),
    allWhere(store.employees, { officeId }),
    allWhere(store.connections, { officeId }),
    allWhere(store.connectors, { officeId }),
  ]);
  return { office, departments, employees, connections, connectors };
}

export async function takeSnapshot(
  store: RelationalCollections,
  officeId: OfficeId,
  reason: string,
  deps: SnapshotDeps,
): Promise<OfficeSnapshot> {
  const config = await readOfficeConfig(store, officeId);
  const snapshot: OfficeSnapshot = {
    id: deps.id(),
    officeId,
    version: config.office.configVersion,
    reason,
    createdAt: deps.now(),
    config,
  };
  await store.snapshots.put(snapshot);
  return snapshot;
}

/** Newest first. */
export async function listSnapshots(
  store: RelationalCollections,
  officeId: OfficeId,
): Promise<OfficeSnapshot[]> {
  const all = await allWhere(store.snapshots, { officeId });
  return all.sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime());
}

async function replaceCollection<T extends Entity>(
  repo: EntityRepository<T>,
  current: readonly T[],
  target: readonly T[],
): Promise<void> {
  const keep = new Set(target.map((t) => t.id));
  for (const c of current) if (!keep.has(c.id)) await repo.delete(c.id);
  for (const t of target) await repo.put(t);
}

/**
 * Makes the office's configuration equal to the snapshot's (with a new
 * configVersion) and records a snapshot of the restored state.
 */
export function restoreSnapshot(
  store: RelationalStore,
  snapshot: OfficeSnapshot,
  deps: SnapshotDeps,
): Promise<OfficeSnapshot> {
  if (snapshot.config.office.id !== snapshot.officeId) {
    return Promise.reject(
      new Error(
        `snapshot ${snapshot.id} belongs to office "${snapshot.config.office.id}", not "${snapshot.officeId}"`,
      ),
    );
  }
  return store.transaction(async (tx) => {
    const current = await readOfficeConfig(tx, snapshot.officeId);
    const nextVersion = current.office.configVersion + 1;
    await tx.offices.put({ ...snapshot.config.office, configVersion: nextVersion });
    await replaceCollection(tx.departments, current.departments, snapshot.config.departments);
    await replaceCollection(tx.employees, current.employees, snapshot.config.employees);
    await replaceCollection(tx.connections, current.connections, snapshot.config.connections);
    await replaceCollection(tx.connectors, current.connectors, snapshot.config.connectors);
    return takeSnapshot(
      tx,
      snapshot.officeId,
      `restore of ${snapshot.id} (${snapshot.reason})`,
      deps,
    );
  });
}

export class OfficeConfigService {
  constructor(
    private readonly store: RelationalStore,
    private readonly deps: SnapshotDeps,
  ) {}

  /** Runs `mutate`, bumps the office configVersion and snapshots, atomically. */
  applyChange(
    officeId: OfficeId,
    reason: string,
    mutate: (tx: RelationalCollections) => Promise<void>,
  ): Promise<OfficeSnapshot> {
    return this.store.transaction(async (tx) => {
      await mutate(tx);
      const office = await tx.offices.get(officeId);
      if (!office) throw new Error(`office "${officeId}" not found`);
      await tx.offices.put({ ...office, configVersion: office.configVersion + 1 });
      return takeSnapshot(tx, officeId, reason, this.deps);
    });
  }

  async diffAgainstCurrent(snapshot: OfficeSnapshot): Promise<ConfigDiff> {
    return diffOfficeConfig(snapshot.config, await readOfficeConfig(this.store, snapshot.officeId));
  }

  restore(snapshot: OfficeSnapshot): Promise<OfficeSnapshot> {
    return restoreSnapshot(this.store, snapshot, this.deps);
  }
}

/**
 * Office configuration snapshots (plan §9): the office plus its departments,
 * employees, connections and connectors at a given configVersion, and a
 * field-level diff between two configurations. Runtime data (tasks, memory,
 * events) is not configuration and never appears here.
 */
import type { Connection } from "../connection/connection.js";
import type { Connector } from "../connector/connector.js";
import type { Department } from "../department/department.js";
import type { Employee } from "../employee/employee.js";
import type { Office, OfficeId } from "../office/office.js";

declare const snapshotIdBrand: unique symbol;
export type SnapshotId = string & { readonly [snapshotIdBrand]: true };

export interface OfficeConfig {
  readonly office: Office;
  readonly departments: readonly Department[];
  readonly employees: readonly Employee[];
  readonly connections: readonly Connection[];
  readonly connectors: readonly Connector[];
}

export interface OfficeSnapshot {
  readonly id: SnapshotId;
  readonly officeId: OfficeId;
  /** The office's configVersion when the snapshot was taken. */
  readonly version: number;
  readonly reason: string;
  readonly createdAt: Date;
  readonly config: OfficeConfig;
}

export interface FieldChange {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface EntityChange<T> {
  readonly id: string;
  readonly before: T;
  readonly after: T;
  readonly fields: readonly FieldChange[];
}

export interface CollectionDiff<T> {
  readonly added: readonly T[];
  readonly removed: readonly T[];
  readonly changed: readonly EntityChange<T>[];
}

export interface ConfigDiff {
  readonly office: readonly FieldChange[];
  readonly departments: CollectionDiff<Department>;
  readonly employees: CollectionDiff<Employee>;
  readonly connections: CollectionDiff<Connection>;
  readonly connectors: CollectionDiff<Connector>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function join(path: string, key: string): string {
  return path.length === 0 ? key : `${path}.${key}`;
}

/** Deep, ordered field-level diff. Keys of `before` first, then keys only in `after`. */
export function diffValues(before: unknown, after: unknown, path = ""): FieldChange[] {
  if (before instanceof Date && after instanceof Date) {
    return before.getTime() === after.getTime() ? [] : [{ path, before, after }];
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: FieldChange[] = [];
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      out.push(...diffValues(before[i], after[i], `${path}[${String(i)}]`));
    }
    return out;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: FieldChange[] = [];
    for (const key of Object.keys(before))
      out.push(...diffValues(before[key], after[key], join(path, key)));
    for (const key of Object.keys(after)) {
      if (!(key in before)) out.push(...diffValues(undefined, after[key], join(path, key)));
    }
    return out;
  }
  return before === after ? [] : [{ path, before, after }];
}

function diffCollection<T extends { readonly id: string }>(
  before: readonly T[],
  after: readonly T[],
): CollectionDiff<T> {
  const byId = (items: readonly T[]): Map<string, T> => new Map(items.map((i) => [i.id, i]));
  const a = byId(before);
  const b = byId(after);
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  const added: T[] = [];
  const removed: T[] = [];
  const changed: EntityChange<T>[] = [];
  for (const id of ids) {
    const x = a.get(id);
    const y = b.get(id);
    if (x === undefined && y !== undefined) added.push(y);
    else if (x !== undefined && y === undefined) removed.push(x);
    else if (x !== undefined && y !== undefined) {
      const fields = diffValues(x, y);
      if (fields.length > 0) changed.push({ id, before: x, after: y, fields });
    }
  }
  return { added, removed, changed };
}

export function diffOfficeConfig(before: OfficeConfig, after: OfficeConfig): ConfigDiff {
  return {
    office: diffValues(before.office, after.office),
    departments: diffCollection(before.departments, after.departments),
    employees: diffCollection(before.employees, after.employees),
    connections: diffCollection(before.connections, after.connections),
    connectors: diffCollection(before.connectors, after.connectors),
  };
}

const COLLECTIONS = ["departments", "employees", "connections", "connectors"] as const;

export function countChanges(diff: ConfigDiff): number {
  return (
    diff.office.length +
    COLLECTIONS.reduce(
      (n, c) => n + diff[c].added.length + diff[c].removed.length + diff[c].changed.length,
      0,
    )
  );
}

export function isEmptyDiff(diff: ConfigDiff): boolean {
  return countChanges(diff) === 0;
}

/**
 * Canonical tables: one per relational collection plus events and the migrations
 * bookkeeping table. Each row stores the full entity as a JSON document in `data`
 * with a few promoted, indexed columns for the common equality filters. Adapters
 * render these portable definitions into their own dialect.
 */
import type { ColumnDef, Migration, TableDef } from "./types.js";

const id: ColumnDef = { name: "id", type: "text", primaryKey: true };
const officeId: ColumnDef = { name: "office_id", type: "text" };
const data: ColumnDef = { name: "data", type: "json" };
const createdAt: ColumnDef = { name: "created_at", type: "timestamp" };

function table(name: string, columns: ColumnDef[], indexColumns: string[][] = []): TableDef {
  return {
    name,
    columns,
    indexes: indexColumns.map((cols) => ({ name: `${name}_${cols.join("_")}`, columns: cols })),
  };
}

export const MIGRATIONS_TABLE: TableDef = {
  name: "_vo_migrations",
  columns: [id, { name: "applied_at", type: "timestamp" }],
};

const INITIAL_TABLES: readonly TableDef[] = [
  table("offices", [id, { name: "name", type: "text" }, createdAt, data]),
  table(
    "departments",
    [id, officeId, { name: "name", type: "text" }, createdAt, data],
    [["office_id"]],
  ),
  table(
    "employees",
    [
      id,
      officeId,
      { name: "department_id", type: "text" },
      { name: "supervisor_id", type: "text", nullable: true },
      { name: "status", type: "text" },
      createdAt,
      data,
    ],
    [["office_id"], ["department_id"], ["office_id", "status"]],
  ),
  table(
    "tasks",
    [
      id,
      officeId,
      { name: "department_id", type: "text" },
      { name: "assignee_id", type: "text", nullable: true },
      { name: "status", type: "text" },
      { name: "priority", type: "text" },
      createdAt,
      { name: "updated_at", type: "timestamp" },
      data,
    ],
    [["office_id"], ["department_id", "status"], ["assignee_id", "status"]],
  ),
  table(
    "connections",
    [
      id,
      officeId,
      { name: "from_id", type: "text" },
      { name: "to_id", type: "text" },
      { name: "kind", type: "text" },
      data,
    ],
    [["office_id"], ["from_id", "kind"]],
  ),
  table(
    "connectors",
    [
      id,
      officeId,
      { name: "name", type: "text" },
      { name: "kind", type: "text" },
      { name: "enabled", type: "boolean" },
      data,
    ],
    [["office_id"]],
  ),
  table(
    "skills",
    [id, { name: "name", type: "text" }, { name: "version", type: "text" }, data],
    [["name"]],
  ),
  table(
    "memories",
    [
      id,
      officeId,
      { name: "scope", type: "text" },
      { name: "owner_id", type: "text" },
      { name: "kind", type: "text" },
      { name: "version", type: "integer" },
      { name: "expires_at", type: "timestamp", nullable: true },
      data,
    ],
    [["office_id"], ["office_id", "owner_id"]],
  ),
  table(
    "events",
    [id, officeId, { name: "at", type: "timestamp" }, { name: "type", type: "text" }, data],
    [
      ["office_id", "at"],
      ["office_id", "type"],
    ],
  ),
];

export const DOCUMENTS_TABLE: TableDef = table(
  "documents",
  [
    id,
    officeId,
    // Flat, and indexed together: listing one tray is what this table is for,
    // and a repository filters on equality of top-level fields.
    { name: "owner_kind", type: "text" },
    { name: "owner_id", type: "text" },
    { name: "tray", type: "text" },
    // Promoted so "is anybody else holding this body?" is a count, not a scan.
    { name: "blob_ref", type: "text" },
    { name: "added_at", type: "timestamp" },
    data,
  ],
  [["office_id"], ["owner_kind", "owner_id", "tray"], ["blob_ref"]],
);

export const SNAPSHOTS_TABLE: TableDef = table(
  "snapshots",
  [id, officeId, { name: "version", type: "integer" }, createdAt, data],
  [["office_id", "version"]],
);

export const USAGE_TABLE: TableDef = table(
  "usage",
  [
    id,
    officeId,
    // Promoted out of the event: "what did this piece of work cost" and "what
    // does this person spend" are the two questions asked of this table, and a
    // repository filters on equality of top-level columns. Both are nullable
    // because not every call is spent on a task, or by anybody in particular.
    { name: "task_id", type: "text", nullable: true },
    { name: "employee_id", type: "text", nullable: true },
    // The moment the call finished, not the moment the row arrived.
    { name: "at", type: "timestamp" },
    data,
  ],
  [["office_id"], ["task_id"], ["office_id", "at"]],
);

export const CANONICAL_TABLES: readonly TableDef[] = [
  ...INITIAL_TABLES,
  SNAPSHOTS_TABLE,
  DOCUMENTS_TABLE,
  USAGE_TABLE,
];

export const CANONICAL_MIGRATIONS: readonly Migration[] = [
  {
    id: "0001_initial",
    up: INITIAL_TABLES.map((t) => ({ op: "createTable", table: t })),
    down: [...INITIAL_TABLES].reverse().map((t) => ({ op: "dropTable", name: t.name })),
  },
  {
    id: "0002_snapshots",
    up: [{ op: "createTable", table: SNAPSHOTS_TABLE }],
    down: [{ op: "dropTable", name: SNAPSHOTS_TABLE.name }],
  },
  {
    id: "0003_documents",
    up: [{ op: "createTable", table: DOCUMENTS_TABLE }],
    down: [{ op: "dropTable", name: DOCUMENTS_TABLE.name }],
  },
  {
    id: "0004_usage",
    up: [{ op: "createTable", table: USAGE_TABLE }],
    down: [{ op: "dropTable", name: USAGE_TABLE.name }],
  },
];

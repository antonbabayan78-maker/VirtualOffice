/**
 * SQLite RelationalStore on Node's built-in `node:sqlite` (no native build step).
 *
 * Rows hold the entity as a JSON document in `data` plus the promoted columns of
 * the canonical schema, so the common filters run in SQL while any other field
 * can still be filtered or sorted through json_extract. Dates are tagged inside
 * the document so they round-trip as Date instances.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  Connection,
  Connector,
  Department,
  Employee,
  MemoryItem,
  Office,
  Skill,
  Task,
} from "@vo/core";
import {
  CANONICAL_MIGRATIONS,
  CANONICAL_TABLES,
  MIGRATIONS_TABLE,
} from "../../schema/canonical.js";
import type { Migration } from "../../schema/types.js";
import { decodeCursor, encodeCursor } from "../../relational/cursor.js";
import {
  COLLECTION_NAMES,
  DEFAULT_MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  type CollectionName,
  type Entity,
  type EntityRepository,
  type ListQuery,
  type Page,
  type RelationalCollections,
  type RelationalStore,
  type Where,
} from "../../relational/types.js";
import type { AdapterFactory, StoreByKind, StoreKind } from "../../stores/registry.js";
import { MigrationRunner, type MigrationStatus, type SqlExecutor } from "../sql/runner.js";

// ---------------------------------------------------------------------------
// Document encoding
// ---------------------------------------------------------------------------

const DATE_TAG = "$date";

export function encodeDocument(entity: unknown): string {
  return JSON.stringify(
    entity,
    function (this: Record<string, unknown>, key: string, value: unknown) {
      const raw = this[key];
      return raw instanceof Date ? { [DATE_TAG]: raw.toISOString() } : value;
    },
  );
}

export function decodeDocument(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown) => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const keys = Object.keys(value);
      const tagged = (value as Record<string, unknown>)[DATE_TAG];
      if (keys.length === 1 && typeof tagged === "string") return new Date(tagged);
    }
    return value;
  });
}

function toSqlValue(value: unknown): SQLInputValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint")
    return value;
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

function snakeCase(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

interface TableMeta {
  readonly name: string;
  /** column -> entity field, excluding id and data. */
  readonly promoted: ReadonlyMap<string, string>;
}

function tableMeta(name: string): TableMeta {
  const table = CANONICAL_TABLES.find((t) => t.name === name);
  if (!table) throw new Error(`no canonical table "${name}"`);
  const promoted = new Map<string, string>();
  for (const c of table.columns)
    if (c.name !== "id" && c.name !== "data") promoted.set(c.name, camelCase(c.name));
  return { name, promoted };
}

const q = (name: string): string => `"${name}"`;

class SqliteRepository<T extends Entity> implements EntityRepository<T> {
  private readonly columns: string[];

  constructor(
    private readonly db: DatabaseSync,
    private readonly meta: TableMeta,
    private readonly maxPageSize: number,
  ) {
    this.columns = ["id", ...this.meta.promoted.keys(), "data"];
  }

  private expr(field: string): string {
    const column = snakeCase(field);
    if (this.meta.promoted.has(column)) return q(column);
    return `json_extract(${q("data")}, '$.${field}')`;
  }

  private whereClause(where: Where<T> | undefined): { sql: string; params: SQLInputValue[] } {
    const entries = Object.entries(where ?? {});
    if (entries.length === 0) return { sql: "", params: [] };
    const parts: string[] = [];
    const params: SQLInputValue[] = [];
    for (const [field, value] of entries) {
      if (value === null || value === undefined) {
        parts.push(`${this.expr(field)} IS NULL`);
      } else {
        parts.push(`${this.expr(field)} = ?`);
        params.push(toSqlValue(value));
      }
    }
    return { sql: ` WHERE ${parts.join(" AND ")}`, params };
  }

  get(id: string): Promise<T | null> {
    const row = this.db
      .prepare(`SELECT ${q("data")} AS data FROM ${q(this.meta.name)} WHERE ${q("id")} = ?`)
      .get(id);
    return Promise.resolve(row ? (decodeDocument(row["data"] as string) as T) : null);
  }

  put(entity: T): Promise<void> {
    const record = entity as unknown as Record<string, unknown>;
    const values: SQLInputValue[] = [entity.id];
    for (const field of this.meta.promoted.values()) values.push(toSqlValue(record[field]));
    values.push(encodeDocument(entity));
    const cols = this.columns.map(q).join(", ");
    const placeholders = this.columns.map(() => "?").join(", ");
    const updates = this.columns
      .filter((c) => c !== "id")
      .map((c) => `${q(c)} = excluded.${q(c)}`)
      .join(", ");
    this.db
      .prepare(
        `INSERT INTO ${q(this.meta.name)} (${cols}) VALUES (${placeholders}) ON CONFLICT(${q("id")}) DO UPDATE SET ${updates}`,
      )
      .run(...values);
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    const result = this.db.prepare(`DELETE FROM ${q(this.meta.name)} WHERE ${q("id")} = ?`).run(id);
    return Promise.resolve(Number(result.changes) > 0);
  }

  count(where?: Where<T>): Promise<number> {
    const w = this.whereClause(where);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM ${q(this.meta.name)}${w.sql}`)
      .get(...w.params);
    return Promise.resolve(Number(row?.["n"] ?? 0));
  }

  list(query: ListQuery<T> = {}): Promise<Page<T>> {
    const field = query.orderBy?.field ?? "id";
    const desc = query.orderBy?.direction === "desc";
    const dir = desc ? "DESC" : "ASC";
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_PAGE_SIZE, this.maxPageSize));
    const sortExpr = this.expr(field);
    const w = this.whereClause(query.where);
    const conditions: string[] = w.sql.length > 0 ? [w.sql.slice(" WHERE ".length)] : [];
    const params: SQLInputValue[] = [...w.params];

    if (query.cursor !== undefined) {
      let after: { v: unknown; id: string };
      try {
        after = decodeCursor(query.cursor);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const cmp = desc ? "<" : ">";
      const v = toSqlValue(after.v);
      if (v === null) {
        // Sort value was NULL: everything with a non-null value comes after (asc) or before (desc).
        conditions.push(desc ? "1 = 0" : `(${sortExpr} IS NOT NULL OR ${q("id")} > ?)`);
        if (!desc) params.push(after.id);
      } else {
        conditions.push(`(${sortExpr} ${cmp} ? OR (${sortExpr} = ? AND ${q("id")} ${cmp} ?))`);
        params.push(v, v, after.id);
      }
    }

    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT ${q("id")} AS id, ${q("data")} AS data, ${sortExpr} AS sort_value FROM ${q(this.meta.name)}${whereSql} ORDER BY sort_value ${dir}, ${q("id")} ${dir} LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map((r) => decodeDocument(r["data"] as string) as T);
    const last = pageRows.at(-1);
    const nextCursor =
      hasMore && last ? encodeCursor({ v: last["sort_value"], id: String(last["id"]) }) : null;
    return Promise.resolve({ items, nextCursor });
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface SqliteStoreOptions {
  /** File path, or ":memory:". */
  readonly path: string;
  readonly migrations?: readonly Migration[];
  readonly maxPageSize?: number;
}

export function sqlitePathFromUrl(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return path.length > 0 ? path : ":memory:";
}

class SqliteExecutor implements SqlExecutor {
  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  listApplied(): Promise<string[]> {
    const rows = this.db
      .prepare(`SELECT ${q("id")} AS id FROM ${q(MIGRATIONS_TABLE.name)} ORDER BY ${q("id")}`)
      .all();
    return Promise.resolve(rows.map((r) => String(r["id"])));
  }

  markApplied(id: string, at: Date): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO ${q(MIGRATIONS_TABLE.name)} (${q("id")}, ${q("applied_at")}) VALUES (?, ?)`,
      )
      .run(id, at.toISOString());
    return Promise.resolve();
  }

  unmarkApplied(id: string): Promise<void> {
    this.db.prepare(`DELETE FROM ${q(MIGRATIONS_TABLE.name)} WHERE ${q("id")} = ?`).run(id);
    return Promise.resolve();
  }
}

function collections(db: DatabaseSync, maxPageSize: number): RelationalCollections {
  const repo = <T extends Entity>(name: CollectionName): EntityRepository<T> =>
    new SqliteRepository<T>(db, tableMeta(name), maxPageSize);
  return {
    offices: repo<Office>("offices"),
    departments: repo<Department>("departments"),
    employees: repo<Employee>("employees"),
    tasks: repo<Task>("tasks"),
    connections: repo<Connection>("connections"),
    connectors: repo<Connector>("connectors"),
    skills: repo<Skill>("skills"),
    memories: repo<MemoryItem>("memories"),
  };
}

export class SqliteRelationalStore implements RelationalStore {
  readonly maxPageSize: number;
  readonly offices: EntityRepository<Office>;
  readonly departments: EntityRepository<Department>;
  readonly employees: EntityRepository<Employee>;
  readonly tasks: EntityRepository<Task>;
  readonly connections: EntityRepository<Connection>;
  readonly connectors: EntityRepository<Connector>;
  readonly skills: EntityRepository<Skill>;
  readonly memories: EntityRepository<MemoryItem>;

  private readonly runner: MigrationRunner;
  private readonly all: RelationalCollections;
  private lock: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: DatabaseSync,
    migrations: readonly Migration[],
    maxPageSize: number,
  ) {
    this.maxPageSize = maxPageSize;
    this.all = collections(db, maxPageSize);
    this.offices = this.all.offices;
    this.departments = this.all.departments;
    this.employees = this.all.employees;
    this.tasks = this.all.tasks;
    this.connections = this.all.connections;
    this.connectors = this.all.connectors;
    this.skills = this.all.skills;
    this.memories = this.all.memories;
    this.runner = new MigrationRunner({
      dialect: "sqlite",
      executor: new SqliteExecutor(db),
      migrations,
      now: () => new Date(),
      store: this.all,
    });
  }

  /** Creates the bookkeeping table when missing and applies pending migrations. */
  async initialize(): Promise<void> {
    const exists = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(MIGRATIONS_TABLE.name);
    if (!exists) for (const sql of this.runner.bootstrapSql()) this.db.exec(sql);
    await this.runner.up();
  }

  migrationStatus(): Promise<MigrationStatus> {
    return this.runner.status();
  }

  async migrateUp(): Promise<void> {
    await this.runner.up();
  }

  async migrateDown(): Promise<void> {
    await this.runner.down();
  }

  /** Sorted user table names (excludes SQLite internals). */
  tables(): Promise<string[]> {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all();
    return Promise.resolve(rows.map((r) => String(r["name"])));
  }

  /** Raw row for tests and diagnostics. */
  debugRow(table: CollectionName, id: string): Record<string, unknown> | null {
    if (!(COLLECTION_NAMES as readonly string[]).includes(table))
      throw new Error(`unknown table "${table}"`);
    const row = this.db.prepare(`SELECT * FROM ${q(table)} WHERE ${q("id")} = ?`).get(id);
    return row ? { ...row } : null;
  }

  /**
   * Transactions are serialized. Everything executed on this connection while a
   * transaction is open commits or rolls back with it.
   */
  transaction<R>(fn: (tx: RelationalCollections) => Promise<R>): Promise<R> {
    const run = async (): Promise<R> => {
      this.db.exec("BEGIN");
      try {
        const result = await fn(this.all);
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    };
    const next = this.lock.then(run);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

export async function openSqliteStore(options: SqliteStoreOptions): Promise<SqliteRelationalStore> {
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  const store = new SqliteRelationalStore(
    db,
    options.migrations ?? CANONICAL_MIGRATIONS,
    options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE,
  );
  await store.initialize();
  return store;
}

/** `sqlite::memory:`, `sqlite:///abs/path.db` or `sqlite:./relative.db`. */
export const sqliteAdapterFactory: AdapterFactory = {
  scheme: "sqlite",
  supports: ["relational"],
  create<K extends StoreKind>(kind: K, url: URL): Promise<StoreByKind[K]> {
    if (kind !== "relational")
      return Promise.reject(new Error(`sqlite adapter does not support ${kind}`));
    return openSqliteStore({ path: sqlitePathFromUrl(url) }) as unknown as Promise<StoreByKind[K]>;
  },
};

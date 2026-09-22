/**
 * SQLite EventStore. SQLite has no table partitioning, so this is the
 * time-bucketed fallback: one table per UTC month, created on demand, queried as
 * a UNION ALL over the buckets a filter touches, and dropped whole for retention.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { decodeCursor, encodeCursor } from "../../relational/cursor.js";
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, type Page } from "../../relational/types.js";
import { NO_CAPABILITIES, type StoreCapabilities } from "../../stores/capabilities.js";
import {
  bucketFor,
  bucketsBetween,
  bucketTableName,
  parseBucketTableName,
  type Bucket,
} from "../../stores/time-buckets.js";
import type { EventFilter, EventQuery, EventStore, StoredEvent } from "../../stores/types.js";
import { decodeDocument, encodeDocument } from "./sqlite-store.js";

const BASE = "events";
const INDEX_TABLE = "events_index";
const q = (name: string): string => `"${name}"`;

export interface SqliteEventStoreOptions {
  readonly path: string;
  readonly maxPageSize?: number;
}

export class SqliteEventStore implements EventStore {
  readonly capabilities: StoreCapabilities = {
    ...NO_CAPABILITIES,
    transactions: true,
    jsonQuery: true,
  };
  private readonly maxPageSize: number;

  constructor(
    private readonly db: DatabaseSync,
    options: { maxPageSize?: number } = {},
  ) {
    this.maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${q(INDEX_TABLE)} (${q("id")} TEXT PRIMARY KEY, ${q("bucket")} TEXT NOT NULL)`,
    );
  }

  private existingBuckets(): Bucket[] {
    const rows = this.db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '${BASE}\\_%' ESCAPE '\\' ORDER BY name`,
      )
      .all();
    return rows
      .map((r) => parseBucketTableName(BASE, String(r["name"])))
      .filter((b): b is Bucket => b !== null);
  }

  bucketTables(): Promise<string[]> {
    return Promise.resolve(this.existingBuckets().map((b) => bucketTableName(BASE, b)));
  }

  private ensureBucket(bucket: Bucket): string {
    const table = bucketTableName(BASE, bucket);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${q(table)} (${q("id")} TEXT PRIMARY KEY, ${q("office_id")} TEXT NOT NULL, ${q("at")} TEXT NOT NULL, ${q("type")} TEXT NOT NULL, ${q("data")} TEXT NOT NULL)`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS ${q(`${table}_office_at`)} ON ${q(table)} (${q("office_id")}, ${q("at")})`,
    );
    return table;
  }

  append(events: readonly StoredEvent[]): Promise<void> {
    const seen = new Set<string>();
    const exists = this.db.prepare(`SELECT 1 FROM ${q(INDEX_TABLE)} WHERE ${q("id")} = ?`);
    for (const e of events) {
      if (seen.has(e.id) || exists.get(e.id))
        return Promise.reject(new Error(`duplicate event id "${e.id}"`));
      seen.add(e.id);
    }
    this.db.exec("SAVEPOINT vo_append");
    try {
      for (const e of events) {
        const bucket = bucketFor(e.at);
        const table = this.ensureBucket(bucket);
        this.db
          .prepare(
            `INSERT INTO ${q(table)} (${q("id")}, ${q("office_id")}, ${q("at")}, ${q("type")}, ${q("data")}) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(e.id, e.officeId, e.at.toISOString(), e.type, encodeDocument(e.payload));
        this.db
          .prepare(`INSERT INTO ${q(INDEX_TABLE)} (${q("id")}, ${q("bucket")}) VALUES (?, ?)`)
          .run(e.id, bucket);
      }
      this.db.exec("RELEASE vo_append");
    } catch (err) {
      this.db.exec("ROLLBACK TO vo_append");
      this.db.exec("RELEASE vo_append");
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve();
  }

  private bucketsFor(filter: EventFilter): string[] {
    const existing = this.existingBuckets();
    const first = existing.at(0);
    const last = existing.at(-1);
    if (first === undefined || last === undefined) return [];
    const from =
      filter.from ??
      new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1));
    const to =
      filter.to ?? new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 1));
    const wanted = new Set(bucketsBetween(from, to));
    return existing.filter((b) => wanted.has(b)).map((b) => bucketTableName(BASE, b));
  }

  private where(
    filter: EventFilter,
    extra: string[] = [],
    extraParams: SQLInputValue[] = [],
  ): { sql: string; params: SQLInputValue[] } {
    const parts = [`${q("office_id")} = ?`];
    const params: SQLInputValue[] = [filter.officeId];
    if (filter.from) {
      parts.push(`${q("at")} >= ?`);
      params.push(filter.from.toISOString());
    }
    if (filter.to) {
      parts.push(`${q("at")} < ?`);
      params.push(filter.to.toISOString());
    }
    if (filter.type !== undefined) {
      parts.push(`${q("type")} = ?`);
      params.push(filter.type);
    }
    parts.push(...extra);
    params.push(...extraParams);
    return { sql: parts.join(" AND "), params };
  }

  query(query: EventQuery): Promise<Page<StoredEvent>> {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_PAGE_SIZE, this.maxPageSize));
    const extra: string[] = [];
    const extraParams: SQLInputValue[] = [];
    if (query.cursor !== undefined) {
      let after: { v: unknown; id: string };
      try {
        after = decodeCursor(query.cursor);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const at = after.v instanceof Date ? after.v.toISOString() : String(after.v);
      extra.push(`(${q("at")} > ? OR (${q("at")} = ? AND ${q("id")} > ?))`);
      extraParams.push(at, at, after.id);
    }
    const tables = this.bucketsFor(query);
    if (tables.length === 0) return Promise.resolve({ items: [], nextCursor: null });
    const w = this.where(query, extra, extraParams);
    const union = tables
      .map(
        (t) =>
          `SELECT ${q("id")} AS id, ${q("office_id")} AS office_id, ${q("at")} AS at, ${q("type")} AS type, ${q("data")} AS data FROM ${q(t)} WHERE ${w.sql}`,
      )
      .join(" UNION ALL ");
    const params = tables.flatMap(() => w.params);
    const rows = this.db
      .prepare(`${union} ORDER BY at ASC, id ASC LIMIT ?`)
      .all(...params, limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items: StoredEvent[] = page.map((r) => ({
      id: String(r["id"]),
      officeId: String(r["office_id"]),
      at: new Date(String(r["at"])),
      type: String(r["type"]),
      payload: decodeDocument(String(r["data"])) as Record<string, unknown>,
    }));
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ v: last.at, id: last.id }) : null;
    return Promise.resolve({ items, nextCursor });
  }

  count(filter: EventFilter): Promise<number> {
    const tables = this.bucketsFor(filter);
    if (tables.length === 0) return Promise.resolve(0);
    const w = this.where(filter);
    let total = 0;
    for (const t of tables) {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${w.sql}`)
        .get(...w.params);
      total += Number(row?.["n"] ?? 0);
    }
    return Promise.resolve(total);
  }

  /** Drops every bucket strictly older than the bucket containing `before`. Returns dropped buckets. */
  dropBucketsBefore(before: Date): Promise<Bucket[]> {
    const cutoff = bucketFor(before);
    const dropped: Bucket[] = [];
    for (const bucket of this.existingBuckets()) {
      if (bucket >= cutoff) continue;
      this.db.exec(`DROP TABLE ${q(bucketTableName(BASE, bucket))}`);
      this.db.prepare(`DELETE FROM ${q(INDEX_TABLE)} WHERE ${q("bucket")} = ?`).run(bucket);
      dropped.push(bucket);
    }
    return Promise.resolve(dropped);
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

export function openSqliteEventStore(options: SqliteEventStoreOptions): Promise<SqliteEventStore> {
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return Promise.resolve(
    new SqliteEventStore(
      db,
      options.maxPageSize === undefined ? {} : { maxPageSize: options.maxPageSize },
    ),
  );
}

/**
 * SQLite VectorStore. SQLite has no native vector index here (sqlite-vec is a
 * later adapter), so this is the brute-force fallback: vectors persist as JSON
 * and similarity is computed in memory over the office's rows.
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { compareValues } from "../../relational/cursor.js";
import { NO_CAPABILITIES, type StoreCapabilities } from "../../stores/capabilities.js";
import { cosineSimilarity } from "../../stores/in-memory.js";
import type { VectorHit, VectorQuery, VectorRecord, VectorStore } from "../../stores/types.js";
import { decodeDocument, encodeDocument } from "./sqlite-store.js";

const q = (name: string): string => `"${name}"`;

export interface SqliteVectorStoreOptions {
  readonly path: string;
}

export class SqliteVectorStore implements VectorStore {
  readonly capabilities: StoreCapabilities = {
    ...NO_CAPABILITIES,
    transactions: true,
    upsert: true,
  };
  dimensions: number | null = null;

  constructor(private readonly db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${q("vectors")} (${q("id")} TEXT PRIMARY KEY, ${q("office_id")} TEXT NOT NULL, ${q("scope")} TEXT NOT NULL, ${q("owner_id")} TEXT NOT NULL, ${q("vector")} TEXT NOT NULL, ${q("metadata")} TEXT NOT NULL)`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS ${q("vectors_office_owner")} ON ${q("vectors")} (${q("office_id")}, ${q("owner_id")})`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${q("vector_meta")} (${q("key")} TEXT PRIMARY KEY, ${q("value")} TEXT NOT NULL)`,
    );
    const row = db
      .prepare(
        `SELECT ${q("value")} AS value FROM ${q("vector_meta")} WHERE ${q("key")} = 'dimensions'`,
      )
      .get();
    if (row) this.dimensions = Number(row["value"]);
  }

  private check(vector: readonly number[]): void {
    if (this.dimensions === null) {
      this.dimensions = vector.length;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ${q("vector_meta")} (${q("key")}, ${q("value")}) VALUES ('dimensions', ?)`,
        )
        .run(String(vector.length));
    } else if (vector.length !== this.dimensions) {
      throw new Error(
        `vector dimension mismatch: expected ${String(this.dimensions)}, got ${String(vector.length)}`,
      );
    }
  }

  upsert(records: readonly VectorRecord[]): Promise<void> {
    try {
      for (const r of records) this.check(r.vector);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    const stmt = this.db.prepare(
      `INSERT INTO ${q("vectors")} (${q("id")}, ${q("office_id")}, ${q("scope")}, ${q("owner_id")}, ${q("vector")}, ${q("metadata")}) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(${q("id")}) DO UPDATE SET ${q("office_id")} = excluded.${q("office_id")}, ${q("scope")} = excluded.${q("scope")}, ${q("owner_id")} = excluded.${q("owner_id")}, ${q("vector")} = excluded.${q("vector")}, ${q("metadata")} = excluded.${q("metadata")}`,
    );
    for (const r of records)
      stmt.run(
        r.id,
        r.officeId,
        r.scope,
        r.ownerId,
        JSON.stringify(r.vector),
        encodeDocument(r.metadata ?? {}),
      );
    return Promise.resolve();
  }

  delete(ids: readonly string[]): Promise<number> {
    let n = 0;
    const stmt = this.db.prepare(`DELETE FROM ${q("vectors")} WHERE ${q("id")} = ?`);
    for (const id of ids) n += Number(stmt.run(id).changes);
    return Promise.resolve(n);
  }

  deleteByOwner(officeId: string, ownerId: string): Promise<number> {
    const result = this.db
      .prepare(`DELETE FROM ${q("vectors")} WHERE ${q("office_id")} = ? AND ${q("owner_id")} = ?`)
      .run(officeId, ownerId);
    return Promise.resolve(Number(result.changes));
  }

  query(query: VectorQuery): Promise<VectorHit[]> {
    if (this.dimensions !== null && query.vector.length !== this.dimensions) {
      return Promise.reject(
        new Error(
          `vector dimension mismatch: expected ${String(this.dimensions)}, got ${String(query.vector.length)}`,
        ),
      );
    }
    const parts = [`${q("office_id")} = ?`];
    const params: SQLInputValue[] = [query.officeId];
    if (query.filter?.scope !== undefined) {
      parts.push(`${q("scope")} = ?`);
      params.push(query.filter.scope);
    }
    if (query.filter?.ownerIds !== undefined) {
      parts.push(`${q("owner_id")} IN (${query.filter.ownerIds.map(() => "?").join(", ")})`);
      params.push(...query.filter.ownerIds);
    }
    const rows = this.db
      .prepare(
        `SELECT ${q("id")} AS id, ${q("vector")} AS vector, ${q("metadata")} AS metadata FROM ${q("vectors")} WHERE ${parts.join(" AND ")}`,
      )
      .all(...params);
    const hits: VectorHit[] = rows.map((r) => ({
      id: String(r["id"]),
      score: cosineSimilarity(query.vector, JSON.parse(String(r["vector"])) as number[]),
      metadata: decodeDocument(String(r["metadata"])) as Record<string, unknown>,
    }));
    hits.sort((a, b) => b.score - a.score || compareValues(a.id, b.id));
    return Promise.resolve(hits.slice(0, query.topK));
  }

  size(): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${q("vectors")}`).get();
    return Promise.resolve(Number(row?.["n"] ?? 0));
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

export function openSqliteVectorStore(
  options: SqliteVectorStoreOptions,
): Promise<SqliteVectorStore> {
  const db = new DatabaseSync(options.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return Promise.resolve(new SqliteVectorStore(db));
}

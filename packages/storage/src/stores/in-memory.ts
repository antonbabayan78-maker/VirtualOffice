/**
 * In-memory adapters for the vector, event, coordination and blob stores, plus the
 * `memory:` adapter factory. Reference implementations and test doubles.
 */
import { InMemoryRelationalStore } from "../relational/in-memory.js";
import { compareValues, decodeCursor, encodeCursor } from "../relational/cursor.js";
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE, type Page } from "../relational/types.js";
import type { AdapterFactory, StoreByKind, StoreKind } from "./registry.js";
import { NO_CAPABILITIES, type StoreCapabilities } from "./capabilities.js";
import { toAsyncIterable } from "./streams.js";
import {
  validateBlobKey,
  type Blob,
  type BlobStore,
  type CoordinationStore,
  type EventFilter,
  type EventQuery,
  type EventStore,
  type StoredEvent,
  type VectorHit,
  type VectorQuery,
  type VectorRecord,
  type VectorStore,
} from "./types.js";

// ---------------------------------------------------------------------------

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export class InMemoryVectorStore implements VectorStore {
  readonly capabilities: StoreCapabilities = {
    ...NO_CAPABILITIES,
    transactions: true,
    upsert: true,
  };
  private readonly records = new Map<string, VectorRecord>();
  dimensions: number | null = null;

  private checkDimensions(vector: readonly number[]): void {
    if (this.dimensions === null) this.dimensions = vector.length;
    else if (vector.length !== this.dimensions) {
      throw new Error(
        `vector dimension mismatch: expected ${String(this.dimensions)}, got ${String(vector.length)}`,
      );
    }
  }

  upsert(records: readonly VectorRecord[]): Promise<void> {
    try {
      for (const r of records) this.checkDimensions(r.vector);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    for (const r of records) this.records.set(r.id, structuredClone(r));
    return Promise.resolve();
  }

  delete(ids: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of ids) if (this.records.delete(id)) n += 1;
    return Promise.resolve(n);
  }

  deleteByOwner(officeId: string, ownerId: string): Promise<number> {
    let n = 0;
    for (const [id, r] of this.records) {
      if (r.officeId === officeId && r.ownerId === ownerId) {
        this.records.delete(id);
        n += 1;
      }
    }
    return Promise.resolve(n);
  }

  query(query: VectorQuery): Promise<VectorHit[]> {
    if (this.dimensions !== null && query.vector.length !== this.dimensions) {
      return Promise.reject(
        new Error(
          `vector dimension mismatch: expected ${String(this.dimensions)}, got ${String(query.vector.length)}`,
        ),
      );
    }
    const hits: VectorHit[] = [];
    for (const r of this.records.values()) {
      if (r.officeId !== query.officeId) continue;
      if (query.filter?.scope !== undefined && r.scope !== query.filter.scope) continue;
      if (query.filter?.ownerIds !== undefined && !query.filter.ownerIds.includes(r.ownerId))
        continue;
      hits.push({
        id: r.id,
        score: cosineSimilarity(query.vector, r.vector),
        metadata: structuredClone(r.metadata ?? {}),
      });
    }
    hits.sort((a, b) => b.score - a.score || compareValues(a.id, b.id));
    return Promise.resolve(hits.slice(0, query.topK));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------

function matchesEvent(e: StoredEvent, f: EventFilter): boolean {
  if (e.officeId !== f.officeId) return false;
  if (f.from !== undefined && e.at.getTime() < f.from.getTime()) return false;
  if (f.to !== undefined && e.at.getTime() >= f.to.getTime()) return false;
  if (f.type !== undefined && e.type !== f.type) return false;
  return true;
}

function eventOrder(a: StoredEvent, b: StoredEvent): number {
  return a.at.getTime() - b.at.getTime() || compareValues(a.id, b.id);
}

export class InMemoryEventStore implements EventStore {
  readonly capabilities: StoreCapabilities = {
    ...NO_CAPABILITIES,
    transactions: true,
    jsonQuery: true,
  };
  private readonly events = new Map<string, StoredEvent>();
  constructor(private readonly maxPageSize: number = DEFAULT_MAX_PAGE_SIZE) {}

  append(events: readonly StoredEvent[]): Promise<void> {
    const batch = new Set<string>();
    for (const e of events) {
      if (this.events.has(e.id) || batch.has(e.id))
        return Promise.reject(new Error(`duplicate event id "${e.id}"`));
      batch.add(e.id);
    }
    for (const e of events) this.events.set(e.id, structuredClone(e));
    return Promise.resolve();
  }

  query(query: EventQuery): Promise<Page<StoredEvent>> {
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_PAGE_SIZE, this.maxPageSize));
    const sorted = [...this.events.values()].filter((e) => matchesEvent(e, query)).sort(eventOrder);
    let start = 0;
    if (query.cursor !== undefined) {
      let after: { v: unknown; id: string };
      try {
        after = decodeCursor(query.cursor);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      const afterAt = after.v instanceof Date ? after.v.getTime() : Number.NaN;
      start = sorted.findIndex(
        (e) => (e.at.getTime() - afterAt || compareValues(e.id, after.id)) > 0,
      );
      if (start === -1) start = sorted.length;
    }
    const items = sorted.slice(start, start + limit).map((e) => structuredClone(e));
    const last = items.at(-1);
    const nextCursor =
      start + limit < sorted.length && last ? encodeCursor({ v: last.at, id: last.id }) : null;
    return Promise.resolve({ items, nextCursor });
  }

  count(filter: EventFilter): Promise<number> {
    let n = 0;
    for (const e of this.events.values()) if (matchesEvent(e, filter)) n += 1;
    return Promise.resolve(n);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class InMemoryCoordinationStore implements CoordinationStore {
  readonly capabilities: StoreCapabilities = {
    ...NO_CAPABILITIES,
    transactions: true,
    upsert: true,
  };
  private readonly entries = new Map<string, Entry>();
  private readonly clock: () => number;

  constructor(options: { clock?: () => number } = {}) {
    this.clock = options.clock ?? Date.now;
  }

  private live(key: string): Entry | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt !== null && this.clock() >= e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.live(key)?.value ?? null);
  }

  set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: ttlMs === undefined ? null : this.clock() + ttlMs });
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.live(key) !== null && this.entries.delete(key));
  }

  incr(key: string, by = 1, ttlMs?: number): Promise<number> {
    const current = this.live(key);
    if (current === null) {
      this.entries.set(key, {
        value: String(by),
        expiresAt: ttlMs === undefined ? null : this.clock() + ttlMs,
      });
      return Promise.resolve(by);
    }
    const next = Number(current.value) + by;
    current.value = String(next);
    return Promise.resolve(next);
  }

  acquireLock(key: string, ttlMs: number, owner: string): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const current = this.live(lockKey);
    if (current !== null && current.value !== owner) return Promise.resolve(false);
    this.entries.set(lockKey, { value: owner, expiresAt: this.clock() + ttlMs });
    return Promise.resolve(true);
  }

  releaseLock(key: string, owner: string): Promise<boolean> {
    const lockKey = `lock:${key}`;
    const current = this.live(lockKey);
    if (current?.value !== owner) return Promise.resolve(false);
    this.entries.delete(lockKey);
    return Promise.resolve(true);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------

const STREAM_CHUNK = 64 * 1024;

export class InMemoryBlobStore implements BlobStore {
  readonly capabilities: StoreCapabilities = NO_CAPABILITIES;
  private readonly blobs = new Map<string, Blob>();

  put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
    try {
      validateBlobKey(key);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    this.blobs.set(key, { data: new Uint8Array(data), contentType: contentType ?? null });
    return Promise.resolve();
  }

  get(key: string): Promise<Blob | null> {
    const b = this.blobs.get(key);
    return Promise.resolve(b ? { data: new Uint8Array(b.data), contentType: b.contentType } : null);
  }

  async putStream(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<void> {
    validateBlobKey(key);
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of source) {
      parts.push(chunk);
      total += chunk.byteLength;
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.byteLength;
    }
    this.blobs.set(key, { data, contentType: contentType ?? null });
  }

  getStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
    const b = this.blobs.get(key);
    if (!b) return Promise.resolve(null);
    const data = new Uint8Array(b.data);
    function* chunks(): Generator<Uint8Array> {
      for (let i = 0; i < data.byteLength; i += STREAM_CHUNK) {
        yield data.subarray(i, Math.min(i + STREAM_CHUNK, data.byteLength));
      }
    }
    return Promise.resolve(toAsyncIterable(chunks()));
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.blobs.delete(key));
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.blobs.has(key));
  }

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.blobs.keys()].filter((k) => k.startsWith(prefix)).sort());
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------

/** `memory://<any-name>` for every store kind. Each URL yields a fresh, isolated store. */
const builders: { [K in StoreKind]: () => StoreByKind[K] } = {
  relational: () => new InMemoryRelationalStore(),
  vector: () => new InMemoryVectorStore(),
  events: () => new InMemoryEventStore(),
  coordination: () => new InMemoryCoordinationStore(),
  blobs: () => new InMemoryBlobStore(),
};

export const memoryAdapterFactory: AdapterFactory = {
  scheme: "memory",
  supports: ["relational", "vector", "events", "coordination", "blobs"],
  create<K extends StoreKind>(kind: K): Promise<StoreByKind[K]> {
    return Promise.resolve(builders[kind]());
  },
};

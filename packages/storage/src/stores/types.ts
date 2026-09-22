/**
 * The four non-relational store interfaces. Together with RelationalStore they
 * form the five independently configurable backends of an office (plan §4.1).
 */
import type { MemoryScope } from "@vo/core";
import type { Page } from "../relational/types.js";
import type { StoreCapabilities } from "./capabilities.js";

// ---------------------------------------------------------------------------
// Vector store: embeddings for memory retrieval.
// ---------------------------------------------------------------------------

export interface VectorRecord {
  readonly id: string;
  readonly officeId: string;
  readonly scope: MemoryScope;
  readonly ownerId: string;
  readonly vector: readonly number[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface VectorQuery {
  readonly officeId: string;
  readonly vector: readonly number[];
  readonly topK: number;
  readonly filter?: {
    readonly scope?: MemoryScope;
    readonly ownerIds?: readonly string[];
  };
}

export interface VectorHit {
  readonly id: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  readonly score: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface VectorStore {
  readonly capabilities: StoreCapabilities;
  /** Fixed by the first upsert; null while empty. */
  readonly dimensions: number | null;
  upsert(records: readonly VectorRecord[]): Promise<void>;
  delete(ids: readonly string[]): Promise<number>;
  deleteByOwner(officeId: string, ownerId: string): Promise<number>;
  query(query: VectorQuery): Promise<VectorHit[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Event store: append-only usage/audit events.
// ---------------------------------------------------------------------------

export interface StoredEvent {
  readonly id: string;
  readonly officeId: string;
  readonly at: Date;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventFilter {
  readonly officeId: string;
  /** Inclusive. */
  readonly from?: Date;
  /** Exclusive. */
  readonly to?: Date;
  readonly type?: string;
}

export interface EventQuery extends EventFilter {
  readonly limit?: number;
  readonly cursor?: string;
}

export interface EventStore {
  readonly capabilities: StoreCapabilities;
  /** Rejects the whole batch if any id already exists. */
  append(events: readonly StoredEvent[]): Promise<void>;
  /** Ordered by `at` ascending, then id. */
  query(query: EventQuery): Promise<Page<StoredEvent>>;
  count(filter: EventFilter): Promise<number>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Coordination store: small shared state (locks, counters, caches).
// ---------------------------------------------------------------------------

export interface CoordinationStore {
  readonly capabilities: StoreCapabilities;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Atomic increment; the ttl applies when the key is created. */
  incr(key: string, by?: number, ttlMs?: number): Promise<number>;
  /** True when acquired or already held by `owner`. */
  acquireLock(key: string, ttlMs: number, owner: string): Promise<boolean>;
  /** True when the lock was held by `owner` and is now released. */
  releaseLock(key: string, owner: string): Promise<boolean>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Blob store: artifacts and attachments.
// ---------------------------------------------------------------------------

export interface Blob {
  readonly data: Uint8Array;
  readonly contentType: string | null;
}

export interface BlobStore {
  readonly capabilities: StoreCapabilities;
  put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
  get(key: string): Promise<Blob | null>;
  /** Writes from a chunk stream without buffering the whole payload. */
  putStream(key: string, source: AsyncIterable<Uint8Array>, contentType?: string): Promise<void>;
  /** Reads as a chunk stream; null when the key does not exist. */
  getStream(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  /** Keys starting with `prefix`, sorted. */
  list(prefix: string): Promise<string[]>;
  close(): Promise<void>;
}

/** Keys are relative, slash-separated paths without traversal. */
export function validateBlobKey(key: string): void {
  if (key.length === 0 || key.startsWith("/") || key.split("/").some((part) => part === "..")) {
    throw new Error(`invalid blob key ${JSON.stringify(key)}`);
  }
}

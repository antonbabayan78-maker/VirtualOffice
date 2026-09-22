/**
 * Relational store interfaces. Domain and orchestrator code depend only on these;
 * adapters (in-memory, SQLite, Postgres, MySQL, ...) implement them and must pass
 * the contract suite in `@vo/storage/testing`.
 */
import type { StoreCapabilities } from "../stores/capabilities.js";
import type {
  Connection,
  Connector,
  Department,
  Employee,
  MemoryItem,
  Office,
  OfficeSnapshot,
  Skill,
  Task,
} from "@vo/core";

export interface Entity {
  readonly id: string;
}

export type SortDirection = "asc" | "desc";

/** Equality filter on top-level fields (primitives only). */
export type Where<T> = Partial<T>;

export interface ListQuery<T extends Entity> {
  readonly where?: Where<T>;
  /** Defaults to id ascending. `id` is always the tiebreaker. */
  readonly orderBy?: { readonly field: keyof T & string; readonly direction: SortDirection };
  /** Clamped to the store's maxPageSize. */
  readonly limit?: number;
  /** Opaque cursor from a previous page. */
  readonly cursor?: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface EntityRepository<T extends Entity> {
  get(id: string): Promise<T | null>;
  /** Insert or replace by id. */
  put(entity: T): Promise<void>;
  /** True when an entity was removed. */
  delete(id: string): Promise<boolean>;
  list(query?: ListQuery<T>): Promise<Page<T>>;
  count(where?: Where<T>): Promise<number>;
}

export interface RelationalCollections {
  readonly offices: EntityRepository<Office>;
  readonly departments: EntityRepository<Department>;
  readonly employees: EntityRepository<Employee>;
  readonly tasks: EntityRepository<Task>;
  readonly connections: EntityRepository<Connection>;
  readonly connectors: EntityRepository<Connector>;
  readonly skills: EntityRepository<Skill>;
  readonly memories: EntityRepository<MemoryItem>;
  readonly snapshots: EntityRepository<OfficeSnapshot>;
}

export const COLLECTION_NAMES = [
  "offices",
  "departments",
  "employees",
  "tasks",
  "connections",
  "connectors",
  "skills",
  "memories",
  "snapshots",
] as const satisfies readonly (keyof RelationalCollections)[];
export type CollectionName = (typeof COLLECTION_NAMES)[number];

export interface RelationalStore extends RelationalCollections {
  readonly capabilities: StoreCapabilities;
  readonly maxPageSize: number;
  /** Runs `fn` atomically: all writes commit together or none do. */
  transaction<R>(fn: (tx: RelationalCollections) => Promise<R>): Promise<R>;
  close(): Promise<void>;
}

export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_PAGE_SIZE = 200;

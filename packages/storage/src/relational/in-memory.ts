/**
 * In-memory RelationalStore: the reference adapter and the test double.
 * Entities are stored as detached clones; transactions are copy-on-write and
 * serialized, so a failing callback leaves the store untouched.
 */
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
import { compareValues, decodeCursor, encodeCursor } from "./cursor.js";
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
} from "./types.js";

type Tables = Record<CollectionName, Map<string, Entity>>;

function emptyTables(): Tables {
  return Object.fromEntries(COLLECTION_NAMES.map((n) => [n, new Map<string, Entity>()])) as Tables;
}

function cloneTables(tables: Tables): Tables {
  return Object.fromEntries(COLLECTION_NAMES.map((n) => [n, new Map(tables[n])])) as Tables;
}

function matches<T extends Entity>(entity: T, where: Where<T> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => (entity as Record<string, unknown>)[k] === v);
}

class InMemoryRepository<T extends Entity> implements EntityRepository<T> {
  constructor(
    private readonly table: () => Map<string, Entity>,
    private readonly maxPageSize: number,
  ) {}

  get(id: string): Promise<T | null> {
    const found = this.table().get(id);
    return Promise.resolve(found ? structuredClone(found as T) : null);
  }

  put(entity: T): Promise<void> {
    this.table().set(entity.id, structuredClone(entity));
    return Promise.resolve();
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.table().delete(id));
  }

  count(where?: Where<T>): Promise<number> {
    let n = 0;
    for (const e of this.table().values()) if (matches(e as T, where)) n += 1;
    return Promise.resolve(n);
  }

  list(query: ListQuery<T> = {}): Promise<Page<T>> {
    const field = query.orderBy?.field ?? "id";
    const dir = query.orderBy?.direction === "desc" ? -1 : 1;
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_PAGE_SIZE, this.maxPageSize));
    const valueOf = (e: T): unknown => (e as Record<string, unknown>)[field];

    const sorted = [...this.table().values()]
      .map((e) => e as T)
      .filter((e) => matches(e, query.where))
      .sort(
        (a, b) => compareValues(valueOf(a), valueOf(b)) * dir || compareValues(a.id, b.id) * dir,
      );

    let start = 0;
    if (query.cursor !== undefined) {
      let after: ReturnType<typeof decodeCursor>;
      try {
        after = decodeCursor(query.cursor);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
      start = sorted.findIndex(
        (e) =>
          (compareValues(valueOf(e), after.v) * dir || compareValues(e.id, after.id) * dir) > 0,
      );
      if (start === -1) start = sorted.length;
    }

    const items = sorted.slice(start, start + limit).map((e) => structuredClone(e));
    const last = items.at(-1);
    const hasMore = start + limit < sorted.length;
    const nextCursor = hasMore && last ? encodeCursor({ v: valueOf(last), id: last.id }) : null;
    return Promise.resolve({ items, nextCursor });
  }
}

function collections(tables: () => Tables, maxPageSize: number): RelationalCollections {
  const repo = <T extends Entity>(name: CollectionName): EntityRepository<T> =>
    new InMemoryRepository<T>(() => tables()[name], maxPageSize);
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

export class InMemoryRelationalStore implements RelationalStore {
  readonly maxPageSize: number;
  readonly offices: EntityRepository<Office>;
  readonly departments: EntityRepository<Department>;
  readonly employees: EntityRepository<Employee>;
  readonly tasks: EntityRepository<Task>;
  readonly connections: EntityRepository<Connection>;
  readonly connectors: EntityRepository<Connector>;
  readonly skills: EntityRepository<Skill>;
  readonly memories: EntityRepository<MemoryItem>;

  private tables: Tables = emptyTables();
  private lock: Promise<void> = Promise.resolve();

  constructor(options: { maxPageSize?: number } = {}) {
    this.maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
    const c = collections(() => this.tables, this.maxPageSize);
    this.offices = c.offices;
    this.departments = c.departments;
    this.employees = c.employees;
    this.tasks = c.tasks;
    this.connections = c.connections;
    this.connectors = c.connectors;
    this.skills = c.skills;
    this.memories = c.memories;
  }

  transaction<R>(fn: (tx: RelationalCollections) => Promise<R>): Promise<R> {
    const run = async (): Promise<R> => {
      const working = cloneTables(this.tables);
      const result = await fn(collections(() => working, this.maxPageSize));
      this.tables = working;
      return result;
    };
    const next = this.lock.then(run);
    this.lock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

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
import type { StoreCapabilities } from "../stores/capabilities.js";
import { applyListQuery, matchesWhere } from "./query-memory.js";
import {
  COLLECTION_NAMES,
  DEFAULT_MAX_PAGE_SIZE,
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
    for (const e of this.table().values()) if (matchesWhere(e as T, where)) n += 1;
    return Promise.resolve(n);
  }

  list(query: ListQuery<T> = {}): Promise<Page<T>> {
    try {
      return Promise.resolve(
        applyListQuery([...this.table().values()] as T[], query, this.maxPageSize),
      );
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
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

export const IN_MEMORY_RELATIONAL_CAPABILITIES: StoreCapabilities = {
  transactions: true,
  jsonQuery: true,
  fullText: false,
  vector: false,
  partitioning: false,
  listenNotify: false,
  upsert: true,
};

export class InMemoryRelationalStore implements RelationalStore {
  readonly capabilities = IN_MEMORY_RELATIONAL_CAPABILITIES;
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

/**
 * Storage registry: maps connection-URL schemes to adapter factories and opens the
 * five stores of an office from configuration. Adding a database means registering
 * a factory; nothing else in the application changes.
 */
import { err, ok, type Result, type ValidationError } from "@vo/core";
import type { RelationalStore } from "../relational/types.js";
import type { StoreCapabilities } from "./capabilities.js";
import type { BlobStore, CoordinationStore, EventStore, VectorStore } from "./types.js";

export const STORE_KINDS = ["relational", "vector", "events", "coordination", "blobs"] as const;
export type StoreKind = (typeof STORE_KINDS)[number];

export interface StoreByKind {
  relational: RelationalStore;
  vector: VectorStore;
  events: EventStore;
  coordination: CoordinationStore;
  blobs: BlobStore;
}

/** Connection URL per store kind. */
export type StorageConfig = Readonly<Record<StoreKind, URL>>;

export interface AdapterFactory {
  /** URL scheme without the colon, e.g. "memory", "sqlite", "postgres". */
  readonly scheme: string;
  readonly supports: readonly StoreKind[];
  create<K extends StoreKind>(kind: K, url: URL): Promise<StoreByKind[K]>;
}

export interface Storage extends StoreByKind {
  readonly capabilities: Readonly<Record<StoreKind, StoreCapabilities>>;
  close(): Promise<void>;
}

export function parseStorageConfig(input: unknown): Result<StorageConfig> {
  if (typeof input !== "object" || input === null) {
    return err([{ path: "", message: "storage config must be an object with one URL per store" }]);
  }
  const record = input as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const out: Partial<Record<StoreKind, URL>> = {};
  for (const kind of STORE_KINDS) {
    const raw = record[kind];
    if (typeof raw !== "string") {
      errors.push({ path: kind, message: "must be a connection URL string" });
      continue;
    }
    try {
      out[kind] = new URL(raw);
    } catch {
      errors.push({ path: kind, message: `"${raw}" is not a valid URL` });
    }
  }
  if (errors.length > 0) return err(errors);
  return ok(out as StorageConfig);
}

export class StorageRegistry {
  private readonly factories = new Map<string, AdapterFactory>();

  register(factory: AdapterFactory): this {
    if (this.factories.has(factory.scheme)) {
      throw new Error(`an adapter for scheme "${factory.scheme}" is already registered`);
    }
    this.factories.set(factory.scheme, factory);
    return this;
  }

  schemes(): string[] {
    return [...this.factories.keys()].sort();
  }

  private resolve(kind: StoreKind, url: URL): AdapterFactory {
    const scheme = url.protocol.replace(/:$/, "");
    const factory = this.factories.get(scheme);
    if (!factory) {
      throw new Error(
        `${kind} store: no adapter for "${url.protocol}" (${url.href}); registered schemes: ${this.schemes().join(", ")}`,
      );
    }
    if (!factory.supports.includes(kind)) {
      throw new Error(
        `${kind} store: adapter "${url.protocol}" does not support ${kind} (${url.href})`,
      );
    }
    return factory;
  }

  async open(config: StorageConfig): Promise<Storage> {
    const factories = Object.fromEntries(
      STORE_KINDS.map((k) => [k, this.resolve(k, config[k])]),
    ) as Record<StoreKind, AdapterFactory>;
    const opened: Partial<StoreByKind> = {};
    try {
      opened.relational = await factories.relational.create("relational", config.relational);
      opened.vector = await factories.vector.create("vector", config.vector);
      opened.events = await factories.events.create("events", config.events);
      opened.coordination = await factories.coordination.create(
        "coordination",
        config.coordination,
      );
      opened.blobs = await factories.blobs.create("blobs", config.blobs);
    } catch (e) {
      await Promise.all(Object.values(opened).map((s) => s.close()));
      throw e;
    }
    const stores = opened as StoreByKind;
    const capabilities = Object.fromEntries(
      STORE_KINDS.map((k) => [k, stores[k].capabilities]),
    ) as Record<StoreKind, StoreCapabilities>;
    return {
      ...stores,
      capabilities,
      close: async () => {
        await Promise.all(STORE_KINDS.map((k) => stores[k].close()));
      },
    };
  }
}

/** Opens storage from raw config using a registry pre-loaded with the built-in adapters. */
export async function openStorage(
  rawConfig: unknown,
  registry?: StorageRegistry,
): Promise<Storage> {
  const parsed = parseStorageConfig(rawConfig);
  if (!parsed.ok) {
    throw new Error(
      `invalid storage config: ${parsed.error.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }
  const reg = registry ?? (await defaultRegistry());
  return reg.open(parsed.value);
}

async function defaultRegistry(): Promise<StorageRegistry> {
  const { memoryAdapterFactory } = await import("./in-memory.js");
  const { sqliteAdapterFactory } = await import("../adapters/sqlite/sqlite-store.js");
  const { fileAdapterFactory } = await import("../adapters/fs/fs-blob-store.js");
  return new StorageRegistry()
    .register(memoryAdapterFactory)
    .register(sqliteAdapterFactory)
    .register(fileAdapterFactory);
}

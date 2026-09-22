/**
 * @vo/storage
 *
 * Repository interfaces and database adapters, migrations, config snapshots.
 * Adapters live under `src/adapters` (SQL) and `src/relational` (interfaces, in-memory).
 */
export const PACKAGE_NAME = "@vo/storage" as const;

export * from "./relational/types.js";
export * from "./relational/cursor.js";
export * from "./relational/in-memory.js";
export * from "./stores/types.js";
export * from "./stores/registry.js";
export * from "./stores/in-memory.js";
export * from "./schema/types.js";
export * from "./schema/canonical.js";
export * from "./adapters/sql/dialect.js";
export * from "./adapters/sql/runner.js";
export * from "./adapters/sqlite/sqlite-store.js";
export * from "./stores/capabilities.js";
export * from "./stores/time-buckets.js";
export * from "./stores/change-feed.js";
export * from "./relational/query-memory.js";
export * from "./adapters/sqlite/sqlite-events.js";
export * from "./adapters/sqlite/sqlite-vectors.js";
export * from "./snapshots/snapshots.js";
export * from "./adapters/fs/fs-blob-store.js";
export * from "./stores/streams.js";

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

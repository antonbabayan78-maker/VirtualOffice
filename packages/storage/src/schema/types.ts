/**
 * Adapter-neutral schema and migration format.
 *
 * Everything here is portable by construction: only the six column types every
 * supported backend can represent, snake_case identifiers, and migration steps
 * that each SQL dialect renders in `adapters/sql/dialect.ts`. Data migrations run
 * through the repository layer so they never contain SQL either.
 */
import type { ValidationError } from "@vo/core";
import type { RelationalCollections } from "../relational/types.js";

export const COLUMN_TYPES = ["text", "integer", "real", "boolean", "timestamp", "json"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface ColumnDef {
  readonly name: string;
  readonly type: ColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly default?: string | number | boolean | null;
}

export interface IndexDef {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique?: boolean;
}

export interface TableDef {
  readonly name: string;
  readonly columns: readonly ColumnDef[];
  readonly indexes?: readonly IndexDef[];
}

export interface DataMigrationContext {
  readonly store: RelationalCollections;
}

export type MigrationStep =
  | { readonly op: "createTable"; readonly table: TableDef }
  | { readonly op: "dropTable"; readonly name: string }
  | { readonly op: "addColumn"; readonly table: string; readonly column: ColumnDef }
  | { readonly op: "dropColumn"; readonly table: string; readonly column: string }
  | { readonly op: "createIndex"; readonly table: string; readonly index: IndexDef }
  | { readonly op: "dropIndex"; readonly table: string; readonly name: string }
  | { readonly op: "renameTable"; readonly from: string; readonly to: string }
  | {
      readonly op: "data";
      readonly name: string;
      readonly run: (ctx: DataMigrationContext) => Promise<void>;
      readonly revert?: (ctx: DataMigrationContext) => Promise<void>;
    };

export interface Migration {
  /** "NNNN_snake_case", ascending across the list. */
  readonly id: string;
  readonly up: readonly MigrationStep[];
  readonly down: readonly MigrationStep[];
}

export const MIGRATION_ID = /^\d{4}_[a-z][a-z0-9_]*$/;
export const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function isColumnType(v: unknown): v is ColumnType {
  return typeof v === "string" && (COLUMN_TYPES as readonly string[]).includes(v);
}

function checkIdentifier(value: string, path: string, errors: ValidationError[]): void {
  if (!IDENTIFIER.test(value))
    errors.push({ path, message: `"${value}" must be a snake_case identifier` });
}

function checkColumn(col: ColumnDef, path: string, errors: ValidationError[]): void {
  checkIdentifier(col.name, `${path}.name`, errors);
  if (!isColumnType(col.type)) {
    errors.push({
      path: `${path}.type`,
      message: `"${String(col.type)}" is not one of ${COLUMN_TYPES.join(", ")}`,
    });
  }
}

function checkTable(table: TableDef, path: string, errors: ValidationError[]): void {
  checkIdentifier(table.name, `${path}.name`, errors);
  table.columns.forEach((c, i) => {
    checkColumn(c, `${path}.columns[${String(i)}]`, errors);
  });
  const pks = table.columns.filter((c) => c.primaryKey);
  if (pks.length !== 1)
    errors.push({ path, message: "a table must have exactly one primary key column" });
  for (const idx of table.indexes ?? []) {
    checkIdentifier(idx.name, `${path}.indexes.${idx.name}`, errors);
    for (const c of idx.columns) {
      if (!table.columns.some((col) => col.name === c)) {
        errors.push({
          path: `${path}.indexes.${idx.name}`,
          message: `index references unknown column "${c}"`,
        });
      }
    }
  }
}

function checkStep(step: MigrationStep, path: string, errors: ValidationError[]): void {
  switch (step.op) {
    case "createTable":
      checkTable(step.table, `${path}.table`, errors);
      break;
    case "dropTable":
      checkIdentifier(step.name, `${path}.name`, errors);
      break;
    case "addColumn":
      checkIdentifier(step.table, `${path}.table`, errors);
      checkColumn(step.column, `${path}.column`, errors);
      break;
    case "dropColumn":
      checkIdentifier(step.table, `${path}.table`, errors);
      checkIdentifier(step.column, `${path}.column`, errors);
      break;
    case "createIndex":
      checkIdentifier(step.table, `${path}.table`, errors);
      checkIdentifier(step.index.name, `${path}.index.name`, errors);
      break;
    case "dropIndex":
      checkIdentifier(step.table, `${path}.table`, errors);
      checkIdentifier(step.name, `${path}.name`, errors);
      break;
    case "renameTable":
      checkIdentifier(step.from, `${path}.from`, errors);
      checkIdentifier(step.to, `${path}.to`, errors);
      break;
    case "data":
      if (step.name.trim().length === 0)
        errors.push({ path: `${path}.name`, message: "data step needs a name" });
      break;
  }
}

export function validateMigrations(migrations: readonly Migration[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const seen = new Set<string>();
  let previous = "";
  migrations.forEach((m, i) => {
    const path = `migrations[${String(i)}]`;
    if (!MIGRATION_ID.test(m.id))
      errors.push({ path: `${path}.id`, message: `"${m.id}" must look like "0001_snake_case"` });
    if (seen.has(m.id))
      errors.push({ path: `${path}.id`, message: `duplicate migration id "${m.id}"` });
    else if (m.id < previous)
      errors.push({
        path: `${path}.id`,
        message: `migration ids must be ascending ("${m.id}" after "${previous}")`,
      });
    seen.add(m.id);
    previous = m.id;
    if (m.up.length === 0)
      errors.push({ path: `${path}.up`, message: "must contain at least one step" });
    const hasDataUp = m.up.some((s) => s.op === "data");
    if (m.down.length === 0 && !hasDataUp)
      errors.push({ path: `${path}.down`, message: "must contain at least one step" });
    m.up.forEach((s, j) => {
      checkStep(s, `${path}.up[${String(j)}]`, errors);
    });
    m.down.forEach((s, j) => {
      checkStep(s, `${path}.down[${String(j)}]`, errors);
    });
  });
  return errors;
}

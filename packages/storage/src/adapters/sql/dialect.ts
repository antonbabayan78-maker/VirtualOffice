/**
 * Renders portable migration steps into SQL for each supported dialect.
 * This is the only place where dialect-specific types and syntax appear.
 */
import type {
  ColumnDef,
  ColumnType,
  IndexDef,
  Migration,
  MigrationStep,
  TableDef,
} from "../../schema/types.js";

export const DIALECTS = ["sqlite", "postgres", "mysql", "mssql"] as const;
export type Dialect = (typeof DIALECTS)[number];

const TYPES: Record<Dialect, Record<ColumnType, string>> = {
  sqlite: {
    text: "TEXT",
    integer: "INTEGER",
    real: "REAL",
    boolean: "INTEGER",
    timestamp: "TEXT",
    json: "TEXT",
  },
  postgres: {
    text: "TEXT",
    integer: "BIGINT",
    real: "DOUBLE PRECISION",
    boolean: "BOOLEAN",
    timestamp: "TIMESTAMPTZ",
    json: "JSONB",
  },
  mysql: {
    text: "TEXT",
    integer: "BIGINT",
    real: "DOUBLE",
    boolean: "TINYINT(1)",
    timestamp: "DATETIME(3)",
    json: "JSON",
  },
  mssql: {
    text: "NVARCHAR(MAX)",
    integer: "BIGINT",
    real: "FLOAT",
    boolean: "BIT",
    timestamp: "DATETIME2",
    json: "NVARCHAR(MAX)",
  },
};

/** Text columns that take part in keys or indexes need a bounded length on MySQL and SQL Server. */
const KEYED_TEXT: Partial<Record<Dialect, string>> = {
  mysql: "VARCHAR(191)",
  mssql: "NVARCHAR(450)",
};

export function quoteIdentifier(dialect: Dialect, name: string): string {
  switch (dialect) {
    case "mysql":
      return `\`${name}\``;
    case "mssql":
      return `[${name}]`;
    case "sqlite":
    case "postgres":
      return `"${name}"`;
  }
}

function literal(dialect: Dialect, value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean")
    return dialect === "postgres" ? (value ? "TRUE" : "FALSE") : value ? "1" : "0";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function columnType(dialect: Dialect, col: ColumnDef, keyed: boolean): string {
  if (col.type === "text" && keyed) return KEYED_TEXT[dialect] ?? TYPES[dialect].text;
  return TYPES[dialect][col.type];
}

function columnSql(dialect: Dialect, col: ColumnDef, keyed: boolean): string {
  const parts = [quoteIdentifier(dialect, col.name), columnType(dialect, col, keyed)];
  if (col.primaryKey) parts.push("PRIMARY KEY");
  else parts.push(col.nullable === true ? "NULL" : "NOT NULL");
  if (col.default !== undefined) parts.push(`DEFAULT ${literal(dialect, col.default)}`);
  return parts.join(" ");
}

function indexSql(dialect: Dialect, table: string, index: IndexDef): string {
  const cols = index.columns.map((c) => quoteIdentifier(dialect, c)).join(", ");
  const unique = index.unique === true ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX ${quoteIdentifier(dialect, index.name)} ON ${quoteIdentifier(dialect, table)} (${cols});`;
}

function keyedColumns(table: TableDef): Set<string> {
  const keyed = new Set<string>();
  for (const c of table.columns) if (c.primaryKey) keyed.add(c.name);
  for (const i of table.indexes ?? []) for (const c of i.columns) keyed.add(c);
  return keyed;
}

function createTableSql(dialect: Dialect, table: TableDef): string[] {
  const keyed = keyedColumns(table);
  const cols = table.columns
    .map((c) => "  " + columnSql(dialect, c, keyed.has(c.name)))
    .join(",\n");
  const out = [`CREATE TABLE ${quoteIdentifier(dialect, table.name)} (\n${cols}\n);`];
  for (const idx of table.indexes ?? []) out.push(indexSql(dialect, table.name, idx));
  return out;
}

export function renderStep(dialect: Dialect, step: MigrationStep): string[] {
  const q = (name: string): string => quoteIdentifier(dialect, name);
  switch (step.op) {
    case "createTable":
      return createTableSql(dialect, step.table);
    case "dropTable":
      return [`DROP TABLE ${q(step.name)};`];
    case "addColumn":
      return [
        `ALTER TABLE ${q(step.table)} ADD ${dialect === "mssql" ? "" : "COLUMN "}${columnSql(dialect, step.column, false)};`,
      ];
    case "dropColumn":
      return [`ALTER TABLE ${q(step.table)} DROP COLUMN ${q(step.column)};`];
    case "createIndex":
      return [indexSql(dialect, step.table, step.index)];
    case "dropIndex":
      return dialect === "mysql" || dialect === "mssql"
        ? [`DROP INDEX ${q(step.name)} ON ${q(step.table)};`]
        : [`DROP INDEX ${q(step.name)};`];
    case "renameTable":
      switch (dialect) {
        case "mysql":
          return [`RENAME TABLE ${q(step.from)} TO ${q(step.to)};`];
        case "mssql":
          return [`EXEC sp_rename ${literal(dialect, step.from)}, ${literal(dialect, step.to)};`];
        case "sqlite":
        case "postgres":
          return [`ALTER TABLE ${q(step.from)} RENAME TO ${q(step.to)};`];
      }
    // eslint-disable-next-line no-fallthrough -- every dialect returns above
    case "data":
      return [];
  }
}

export function renderMigration(
  dialect: Dialect,
  migration: Migration,
  direction: "up" | "down",
): string[] {
  return migration[direction].flatMap((step) => renderStep(dialect, step));
}

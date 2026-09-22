#!/usr/bin/env node
/**
 * Portability lint (plan §4.1, rules 1 and 2).
 *
 *   no-sql-outside-adapters  SQL statements in string/template literals are only
 *                            allowed under packages/storage/src/adapters.
 *   portable-schema-types    The canonical schema (packages/storage/src/schema) may
 *                            only use types every backend supports; adapter-specific
 *                            types (JSONB, SERIAL, UUID, ...) belong in adapters.
 *
 * Usage: node tooling/scripts/portability-lint.ts   (scans packages/*\/src and apps/*\/src)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

export type PortabilityRule = "no-sql-outside-adapters" | "portable-schema-types";

export interface PortabilityViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: PortabilityRule;
  readonly message: string;
}

export const SQL_ALLOWED_DIRS = ["packages/storage/src/adapters/"] as const;
export const CANONICAL_SCHEMA_DIR = "packages/storage/src/schema/";

const SCANNED = /^(?:packages|apps)\/[^/]+\/src\/.+\.ts$/;

const SQL_STATEMENT =
  /\b(?:SELECT\s+(?:\*|[\w"`]+)\s+FROM\b|INSERT\s+INTO\s+[\w"`]+|UPDATE\s+[\w"`]+\s+SET\b|DELETE\s+FROM\s+[\w"`]+|CREATE\s+(?:TABLE|INDEX|UNIQUE\s+INDEX)\s|ALTER\s+TABLE\s|DROP\s+(?:TABLE|INDEX)\s)/i;

const NON_PORTABLE_TYPES =
  /\b(?:JSONB|SERIAL|BIGSERIAL|SMALLSERIAL|TIMESTAMPTZ|UUID|NVARCHAR|VARCHAR2|CLOB|BYTEA|TINYINT|MEDIUMINT|AUTO_INCREMENT|AUTOINCREMENT|ENUM|ARRAY|HSTORE|IDENTITY)\b/g;

export function isScanned(relativePath: string): boolean {
  if (!SCANNED.test(relativePath)) return false;
  if (relativePath.endsWith(".test.ts") || relativePath.endsWith(".d.ts")) return false;
  if (relativePath.endsWith(".config.ts")) return false;
  return true;
}

function lineAt(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++)
    if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

interface Literal {
  start: number;
  text: string;
}

/** Extracts string and template literal contents, skipping comments. */
export function extractLiterals(content: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    const next = content[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && content[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const start = i + 1;
      i++;
      while (i < n && content[i] !== quote) {
        if (content[i] === "\\") i++;
        else if (quote !== "`" && content[i] === "\n") break;
        i++;
      }
      out.push({ start, text: content.slice(start, i) });
      i++;
      continue;
    }
    i++;
  }
  return out;
}

export function checkFile(relativePath: string, content: string): PortabilityViolation[] {
  const violations: PortabilityViolation[] = [];
  const file = relativePath.replace(/\\/g, "/");

  if (!SQL_ALLOWED_DIRS.some((dir) => file.startsWith(dir))) {
    for (const literal of extractLiterals(content)) {
      const match = SQL_STATEMENT.exec(literal.text);
      if (match) {
        violations.push({
          file,
          line: lineAt(content, literal.start + match.index),
          rule: "no-sql-outside-adapters",
          message: `SQL "${match[0].trim()}" found outside ${SQL_ALLOWED_DIRS.join(", ")}; domain code must go through repository interfaces`,
        });
      }
    }
  }

  if (file.startsWith(CANONICAL_SCHEMA_DIR)) {
    for (const match of content.matchAll(NON_PORTABLE_TYPES)) {
      violations.push({
        file,
        line: lineAt(content, match.index),
        rule: "portable-schema-types",
        message: `"${match[0]}" is adapter-specific; the canonical schema only uses TEXT, INTEGER, REAL, BOOLEAN, TIMESTAMP and JSON`,
      });
    }
  }

  return violations;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function scanRepository(root: string): PortabilityViolation[] {
  const violations: PortabilityViolation[] = [];
  for (const group of ["packages", "apps"]) {
    for (const file of walk(join(root, group))) {
      const rel = relative(root, file).replace(/\\/g, "/");
      if (!isScanned(rel)) continue;
      violations.push(...checkFile(rel, readFileSync(file, "utf8")));
    }
  }
  return violations;
}

export function formatReport(violations: PortabilityViolation[]): string {
  if (violations.length === 0) return "portability-lint: ok";
  const lines = [`portability-lint: ${String(violations.length)} violation(s)`];
  for (const v of violations) lines.push(`  ${v.file}:${String(v.line)}  [${v.rule}] ${v.message}`);
  return lines.join("\n");
}

const invokedDirectly = process.argv[1]?.endsWith("portability-lint.ts") ?? false;
if (invokedDirectly) {
  const violations = scanRepository(resolve(process.cwd()));
  console.log(formatReport(violations));
  process.exitCode = violations.length === 0 ? 0 : 1;
}

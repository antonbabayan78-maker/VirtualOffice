/**
 * Memory item with scope and sharing.
 *
 * Scope decides the natural audience: an employee item is the employee's own,
 * a department item belongs to the department's members, an office item to
 * everyone in the office. Sharing adds grants on top: other departments, named
 * employees, or the whole office. Nothing ever crosses an office boundary.
 */
import type { DepartmentId } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const memoryItemIdBrand: unique symbol;
export type MemoryItemId = string & { readonly [memoryItemIdBrand]: true };

export const MEMORY_SCOPES = ["office", "department", "employee"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_KINDS = ["fact", "procedure", "episode", "summary"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemorySharing {
  /** Readable by every employee in the office. */
  readonly office: boolean;
  /** Readable by members of these departments. */
  readonly departments: readonly DepartmentId[];
  /** Readable by these employees. */
  readonly employees: readonly EmployeeId[];
}

export const PRIVATE: MemorySharing = { office: false, departments: [], employees: [] };

export interface MemoryItem {
  readonly id: MemoryItemId;
  readonly officeId: OfficeId;
  readonly scope: MemoryScope;
  /** OfficeId, DepartmentId or EmployeeId depending on scope. */
  readonly ownerId: string;
  readonly kind: MemoryKind;
  readonly content: string;
  readonly sharing: MemorySharing;
  readonly version: number;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MemoryReader {
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly employeeId: EmployeeId;
}

export interface CreateMemoryItemInput {
  readonly officeId: OfficeId;
  readonly scope: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly content: string;
  readonly sharing?: MemorySharing;
  readonly expiresAt?: Date;
}

export interface MemoryDeps {
  readonly id: () => MemoryItemId;
  readonly now: () => Date;
}

export const MEMORY_CONTENT_MAX_LENGTH = 50_000;

function isScope(v: unknown): v is MemoryScope {
  return typeof v === "string" && (MEMORY_SCOPES as readonly string[]).includes(v);
}

function isKind(v: unknown): v is MemoryKind {
  return typeof v === "string" && (MEMORY_KINDS as readonly string[]).includes(v);
}

function validateContent(raw: string): ValidationError[] {
  const content = raw.trim();
  if (content.length === 0) return [{ path: "content", message: "must not be empty" }];
  if (content.length > MEMORY_CONTENT_MAX_LENGTH) {
    return [
      {
        path: "content",
        message: `must be at most ${String(MEMORY_CONTENT_MAX_LENGTH)} characters`,
      },
    ];
  }
  return [];
}

function validateUnique(ids: readonly string[], path: string): ValidationError[] {
  if (new Set(ids).size !== ids.length) return [{ path, message: "must not contain duplicates" }];
  return [];
}

export function createMemoryItem(
  input: CreateMemoryItemInput,
  deps: MemoryDeps,
): Result<MemoryItem> {
  const errors: ValidationError[] = [];
  if (!isScope(input.scope))
    errors.push({ path: "scope", message: `must be one of ${MEMORY_SCOPES.join(", ")}` });
  if (!isKind(input.kind))
    errors.push({ path: "kind", message: `must be one of ${MEMORY_KINDS.join(", ")}` });
  if (input.ownerId.length === 0) errors.push({ path: "ownerId", message: "must not be empty" });
  errors.push(...validateContent(input.content));

  const sharing = input.sharing ?? PRIVATE;
  errors.push(...validateUnique(sharing.departments, "sharing.departments"));
  errors.push(...validateUnique(sharing.employees, "sharing.employees"));

  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
    errors.push({ path: "expiresAt", message: "must be a valid date" });
  }

  if (errors.length > 0 || !isScope(input.scope) || !isKind(input.kind)) return err(errors);

  const now = deps.now();
  return ok({
    id: deps.id(),
    officeId: input.officeId,
    scope: input.scope,
    ownerId: input.ownerId,
    kind: input.kind,
    content: input.content.trim(),
    sharing: {
      office: sharing.office,
      departments: [...sharing.departments],
      employees: [...sharing.employees],
    },
    version: 1,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
}

function isNaturalAudience(item: MemoryItem, reader: MemoryReader): boolean {
  switch (item.scope) {
    case "employee":
      return item.ownerId === reader.employeeId;
    case "department":
      return item.ownerId === reader.departmentId;
    case "office":
      return true;
  }
}

export function canRead(item: MemoryItem, reader: MemoryReader, at: Date): boolean {
  if (item.officeId !== reader.officeId) return false;
  if (item.expiresAt !== null && at.getTime() >= item.expiresAt.getTime()) return false;
  if (isNaturalAudience(item, reader)) return true;
  const s = item.sharing;
  return (
    s.office ||
    s.departments.includes(reader.departmentId) ||
    s.employees.includes(reader.employeeId)
  );
}

/** Writing is never granted by sharing; only the natural audience may write. */
export function canWrite(item: MemoryItem, reader: MemoryReader): boolean {
  return item.officeId === reader.officeId && isNaturalAudience(item, reader);
}

export function updateMemoryContent(
  item: MemoryItem,
  content: string,
  now: Date,
): Result<MemoryItem> {
  const errors = validateContent(content);
  if (errors.length > 0) return err(errors);
  return ok({ ...item, content: content.trim(), version: item.version + 1, updatedAt: now });
}

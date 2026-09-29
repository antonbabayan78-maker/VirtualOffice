/**
 * Department: a colored zone on the office canvas with its own configuration and
 * review policy. Memory scope, storage reference and budget arrive with their tasks.
 */
import type { OfficeId } from "../office/office.js";
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
import { isPriority, TASK_PRIORITIES, type TaskPriority } from "../task/task.js";
import { parseSchedule, type Schedule } from "../office/schedule.js";
import { validateGrantShape, type ToolGrant } from "../connector/connector.js";
import { parseReviewPolicy, type ReviewPolicy } from "./review-policy.js";

declare const departmentIdBrand: unique symbol;
export type DepartmentId = string & { readonly [departmentIdBrand]: true };

export interface Position {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Department {
  readonly id: DepartmentId;
  readonly officeId: OfficeId;
  readonly name: string;
  /** Normalized "#rrggbb". */
  readonly color: string;
  /** Emoji or icon name; null when unset. */
  readonly icon: string | null;
  readonly position: Position;
  readonly size: Size;
  /** Free-form department configuration, interpreted by plugins and the UI. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly reviewPolicy: ReviewPolicy;
  /**
   * The department's standing priority. It outranks anything its people or
   * their tasks ask for, and is outranked by the office's — which is how a
   * department is put into crunch without anyone editing every task.
   */
  readonly priority: TaskPriority;
  /**
   * What everything this department produces has to achieve. A task states its
   * own only when its work needs something beyond this, and a reviewer answers
   * the combined list rather than its own idea of the job.
   */
  readonly definitionOfDone: readonly string[];
  /** When this department works; the office's hours gate it too. */
  readonly schedule: Schedule;
  /**
   * What everyone in this room may call. Granted here rather than per person so
   * that "designers get Figma" is said once; an employee's own grants are added
   * to these, never subtracted from them.
   */
  readonly toolGrants: readonly ToolGrant[];
  readonly createdAt: Date;
}

export interface CreateDepartmentInput {
  readonly officeId: OfficeId;
  readonly name: string;
  readonly color: string;
  readonly position: Position;
  readonly icon?: string;
  readonly size?: Size;
  readonly config?: Record<string, unknown>;
  /** Unvalidated; defaults to manager review. */
  readonly reviewPolicy?: unknown;
  /** Defaults to normal. Loose on the way in, narrow on the entity. */
  readonly priority?: string;
  readonly definitionOfDone?: readonly string[];
  readonly toolGrants?: readonly ToolGrant[];
  readonly schedule?: unknown;
}

export interface DepartmentDeps {
  readonly id: () => DepartmentId;
  readonly now: () => Date;
}

export const DEPARTMENT_NAME_MAX_LENGTH = 60;
export const DEPARTMENT_ICON_MAX_LENGTH = 32;
export const MIN_DEPARTMENT_SIZE: Size = { width: 200, height: 120 };
export const DEFAULT_DEPARTMENT_SIZE: Size = { width: 480, height: 320 };

const HEX_6 = /^#([0-9a-f]{6})$/i;
const HEX_3 = /^#([0-9a-f]{3})$/i;

export function normalizeHexColor(raw: unknown): Result<string> {
  if (typeof raw === "string") {
    if (HEX_6.test(raw)) return ok(raw.toLowerCase());
    if (HEX_3.test(raw)) {
      const digits = raw.slice(1).replace(/./g, (c) => c + c);
      return ok(`#${digits.toLowerCase()}`);
    }
  }
  return err([{ path: "color", message: 'must be a hex color like "#3b82f6" or "#fa0"' }]);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validateName(raw: string, existing: readonly { readonly name: string }[]): Result<string> {
  const name = raw.trim();
  if (name.length === 0) return err([{ path: "name", message: "must not be empty" }]);
  if (name.length > DEPARTMENT_NAME_MAX_LENGTH) {
    return err([
      { path: "name", message: `must be at most ${String(DEPARTMENT_NAME_MAX_LENGTH)} characters` },
    ]);
  }
  const lower = name.toLowerCase();
  if (existing.some((d) => d.name.trim().toLowerCase() === lower)) {
    return err([
      { path: "name", message: `a department named "${name}" already exists in this office` },
    ]);
  }
  return ok(name);
}

function validatePosition(v: unknown): ValidationError[] {
  if (!isRecord(v)) return [{ path: "position", message: "must be an object with x and y" }];
  const errors: ValidationError[] = [];
  if (!finiteNumber(v["x"]))
    errors.push({ path: "position.x", message: "must be a finite number" });
  if (!finiteNumber(v["y"]))
    errors.push({ path: "position.y", message: "must be a finite number" });
  return errors;
}

function validateSize(v: unknown): ValidationError[] {
  if (!isRecord(v)) return [{ path: "size", message: "must be an object with width and height" }];
  const errors: ValidationError[] = [];
  const w = v["width"];
  const h = v["height"];
  if (!finiteNumber(w) || w < MIN_DEPARTMENT_SIZE.width) {
    errors.push({
      path: "size.width",
      message: `must be a number >= ${String(MIN_DEPARTMENT_SIZE.width)}`,
    });
  }
  if (!finiteNumber(h) || h < MIN_DEPARTMENT_SIZE.height) {
    errors.push({
      path: "size.height",
      message: `must be a number >= ${String(MIN_DEPARTMENT_SIZE.height)}`,
    });
  }
  return errors;
}

/**
 * What may be changed about a department after it exists. Absent leaves a field
 * alone; null clears one that is allowed to be empty, such as its icon.
 */
export interface UpdateDepartmentInput {
  readonly name?: string;
  readonly color?: string;
  readonly icon?: string | null;
  readonly config?: Record<string, unknown>;
  readonly reviewPolicy?: unknown;
  readonly schedule?: unknown;
  readonly priority?: string;
  readonly definitionOfDone?: readonly string[];
  readonly toolGrants?: readonly ToolGrant[];
}

/**
 * Applies changes to a department, validating them exactly as creating one
 * does. Its identity, its place on the canvas and when it was created carry
 * over; a department keeping its own name is not a duplicate of itself, which
 * re-running createDepartment against the office would have called one.
 */
/** Each entry has to be a piece of text somebody could actually check. */
function validateDefinitionOfDone(entries: readonly string[]): ValidationError[] {
  if (entries.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
    return [{ path: "definitionOfDone", message: "must each be text" }];
  }
  return [];
}

export function updateDepartment(
  department: Department,
  changes: UpdateDepartmentInput,
  existing: readonly { readonly id: string; readonly name: string }[],
): Result<Department> {
  const errors: ValidationError[] = [];

  const others = existing.filter((candidate) => candidate.id !== department.id);
  const name =
    changes.name === undefined ? ok(department.name) : validateName(changes.name, others);
  if (!name.ok) errors.push(...name.error);

  const color =
    changes.color === undefined ? ok(department.color) : normalizeHexColor(changes.color);
  if (!color.ok) errors.push(...color.error);

  let icon: string | null = department.icon;
  if (changes.icon === null) icon = null;
  else if (changes.icon !== undefined) {
    const trimmed = changes.icon.trim();
    if (trimmed.length === 0 || trimmed.length > DEPARTMENT_ICON_MAX_LENGTH) {
      errors.push({
        path: "icon",
        message: `must be 1-${String(DEPARTMENT_ICON_MAX_LENGTH)} characters`,
      });
    } else icon = trimmed;
  }

  const config = changes.config ?? department.config;
  if (!isRecord(config)) errors.push({ path: "config", message: "must be an object" });

  const reviewPolicy =
    changes.reviewPolicy === undefined
      ? ok(department.reviewPolicy)
      : parseReviewPolicy(changes.reviewPolicy);
  if (!reviewPolicy.ok) errors.push(...prefixErrors("reviewPolicy", reviewPolicy.error));

  const schedule =
    changes.schedule === undefined ? ok(department.schedule) : parseSchedule(changes.schedule);
  if (!schedule.ok) errors.push(...prefixErrors("schedule", schedule.error));

  const definitionOfDone = changes.definitionOfDone ?? department.definitionOfDone;
  errors.push(...validateDefinitionOfDone(definitionOfDone));

  const toolGrants =
    changes.toolGrants === undefined
      ? ok(department.toolGrants)
      : validateGrantShape(changes.toolGrants);
  if (!toolGrants.ok) errors.push(...toolGrants.error);

  const priority = changes.priority ?? department.priority;
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  if (
    errors.length > 0 ||
    !name.ok ||
    !color.ok ||
    !reviewPolicy.ok ||
    !schedule.ok ||
    !isPriority(priority)
  ) {
    return err(errors);
  }

  return ok({
    ...department,
    name: name.value,
    color: color.value,
    icon,
    config: { ...config },
    reviewPolicy: reviewPolicy.value,
    schedule: schedule.value,
    priority,
    definitionOfDone: [...definitionOfDone],
    toolGrants: toolGrants.ok ? [...toolGrants.value] : [],
  });
}

export function createDepartment(
  input: CreateDepartmentInput,
  existing: readonly { readonly name: string }[],
  deps: DepartmentDeps,
): Result<Department> {
  const errors: ValidationError[] = [];

  const name = validateName(input.name, existing);
  if (!name.ok) errors.push(...name.error);

  const color = normalizeHexColor(input.color);
  if (!color.ok) errors.push(...color.error);

  errors.push(...validatePosition(input.position));

  const size = input.size ?? DEFAULT_DEPARTMENT_SIZE;
  errors.push(...validateSize(size));

  const icon = input.icon ?? null;
  if (icon !== null && (icon.length === 0 || icon.length > DEPARTMENT_ICON_MAX_LENGTH)) {
    errors.push({
      path: "icon",
      message: `must be 1-${String(DEPARTMENT_ICON_MAX_LENGTH)} characters`,
    });
  }

  const config = input.config ?? {};
  if (!isRecord(config)) errors.push({ path: "config", message: "must be an object" });

  const reviewPolicy = parseReviewPolicy(input.reviewPolicy);
  if (!reviewPolicy.ok) errors.push(...prefixErrors("reviewPolicy", reviewPolicy.error));

  const schedule = parseSchedule(input.schedule ?? { kind: "always" });
  if (!schedule.ok) errors.push(...prefixErrors("schedule", schedule.error));

  const definitionOfDone = input.definitionOfDone ?? [];
  errors.push(...validateDefinitionOfDone(definitionOfDone));

  const toolGrants = validateGrantShape(input.toolGrants);
  if (!toolGrants.ok) errors.push(...toolGrants.error);

  const priority = input.priority ?? "normal";
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  if (
    errors.length > 0 ||
    !name.ok ||
    !color.ok ||
    !reviewPolicy.ok ||
    !schedule.ok ||
    !isPriority(priority)
  ) {
    return err(errors);
  }

  return ok({
    id: deps.id(),
    officeId: input.officeId,
    name: name.value,
    color: color.value,
    icon,
    position: { x: input.position.x, y: input.position.y },
    size: { width: size.width, height: size.height },
    config: { ...config },
    reviewPolicy: reviewPolicy.value,
    schedule: schedule.value,
    priority,
    definitionOfDone: [...definitionOfDone],
    toolGrants: toolGrants.ok ? [...toolGrants.value] : [],
    createdAt: deps.now(),
  });
}

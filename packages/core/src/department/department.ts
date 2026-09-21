/**
 * Department: a colored zone on the office canvas with its own configuration and
 * review policy. Memory scope, storage reference and budget arrive with their tasks.
 */
import type { OfficeId } from "../office/office.js";
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
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

  if (errors.length > 0 || !name.ok || !color.ok || !reviewPolicy.ok) return err(errors);

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
    createdAt: deps.now(),
  });
}

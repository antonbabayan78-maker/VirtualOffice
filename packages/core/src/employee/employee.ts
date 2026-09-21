/**
 * Employee: an agent inside a department. Configuration (LLM, skills, tool grants,
 * schedule, supervisor, workspace) plus a status lifecycle:
 *
 *   active <-> paused -> terminated (final)
 *
 * Budget arrives with the telemetry budgets task.
 */
import type { ToolGrant } from "../connector/connector.js";
import { normalizeHexColor, type DepartmentId } from "../department/department.js";
import type { OfficeId } from "../office/office.js";
import { parseSchedule, type Schedule } from "../office/schedule.js";
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
import { parseLlmConfig, type LlmConfig } from "./llm-config.js";

declare const employeeIdBrand: unique symbol;
export type EmployeeId = string & { readonly [employeeIdBrand]: true };

export type EmployeeStatus = "active" | "paused" | "terminated";

export interface Employee {
  readonly id: EmployeeId;
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly name: string;
  readonly role: string;
  readonly avatar: string | null;
  readonly color: string;
  readonly llm: LlmConfig;
  readonly skillIds: readonly string[];
  readonly toolGrants: readonly ToolGrant[];
  /** null inherits the office schedule. */
  readonly schedule: Schedule | null;
  /** Who controls this employee's work. null means the office owner. */
  readonly supervisorId: EmployeeId | null;
  /** Where the work is stored (connector reference). null means the department default. */
  readonly workspaceRef: string | null;
  readonly status: EmployeeStatus;
  readonly statusChangedAt: Date;
  readonly createdAt: Date;
}

export interface CreateEmployeeInput {
  readonly name: string;
  readonly role: string;
  readonly color: string;
  readonly llm: unknown;
  readonly avatar?: string;
  readonly skillIds?: readonly string[];
  readonly toolGrants?: readonly ToolGrant[];
  readonly schedule?: unknown;
  readonly supervisorId?: string;
  readonly workspaceRef?: string;
}

/** Facts the caller resolved from storage so the domain stays pure. */
export interface CreateEmployeeContext {
  readonly department: { readonly id: DepartmentId; readonly officeId: OfficeId };
  /** The resolved supervisor, or null when none was requested or it does not exist. */
  readonly supervisor: {
    readonly id: EmployeeId;
    readonly officeId: OfficeId;
    readonly status: EmployeeStatus;
  } | null;
}

export interface EmployeeDeps {
  readonly id: () => EmployeeId;
  readonly now: () => Date;
}

export const EMPLOYEE_TEXT_MAX_LENGTH = 80;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateText(raw: unknown, path: string): Result<string> {
  if (typeof raw !== "string") return err([{ path, message: "must be a string" }]);
  const value = raw.trim();
  if (value.length === 0) return err([{ path, message: "must not be empty" }]);
  if (value.length > EMPLOYEE_TEXT_MAX_LENGTH) {
    return err([
      { path, message: `must be at most ${String(EMPLOYEE_TEXT_MAX_LENGTH)} characters` },
    ]);
  }
  return ok(value);
}

function validateSkillIds(raw: readonly string[] | undefined): Result<readonly string[]> {
  const ids = raw ?? [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim().length === 0) {
      return err([{ path: "skillIds", message: "every skill id must be a non-empty string" }]);
    }
    if (seen.has(id)) return err([{ path: "skillIds", message: `duplicate skill id "${id}"` }]);
    seen.add(id);
  }
  return ok([...ids]);
}

function validateToolGrants(raw: readonly ToolGrant[] | undefined): Result<readonly ToolGrant[]> {
  const grants = raw ?? [];
  const errors: ValidationError[] = [];
  grants.forEach((g: unknown, i) => {
    const path = `toolGrants[${String(i)}]`;
    if (!isRecord(g)) {
      errors.push({ path, message: "must be an object with connectorId and tool" });
      return;
    }
    if (typeof g["connectorId"] !== "string" || g["connectorId"].length === 0) {
      errors.push({ path: `${path}.connectorId`, message: "must be a non-empty string" });
    }
    if (typeof g["tool"] !== "string" || g["tool"].length === 0) {
      errors.push({ path: `${path}.tool`, message: 'must be a tool name or "*"' });
    }
  });
  if (errors.length > 0) return err(errors);
  return ok(grants.map((g) => ({ connectorId: g.connectorId, tool: g.tool })));
}

function validateSupervisor(
  requested: string | undefined,
  selfId: EmployeeId,
  ctx: CreateEmployeeContext,
): Result<EmployeeId | null> {
  if (requested === undefined) return ok(null);
  const s = ctx.supervisor;
  if (s?.id !== requested) {
    return err([{ path: "supervisorId", message: `supervisor "${requested}" was not found` }]);
  }
  if (s.id === selfId)
    return err([{ path: "supervisorId", message: "an employee cannot supervise themselves" }]);
  if (s.officeId !== ctx.department.officeId) {
    return err([{ path: "supervisorId", message: "supervisor must belong to the same office" }]);
  }
  if (s.status === "terminated") {
    return err([{ path: "supervisorId", message: "supervisor is terminated" }]);
  }
  return ok(s.id);
}

export function createEmployee(
  input: CreateEmployeeInput,
  ctx: CreateEmployeeContext,
  deps: EmployeeDeps,
): Result<Employee> {
  const errors: ValidationError[] = [];
  const id = deps.id();

  const name = validateText(input.name, "name");
  if (!name.ok) errors.push(...name.error);
  const role = validateText(input.role, "role");
  if (!role.ok) errors.push(...role.error);
  const color = normalizeHexColor(input.color);
  if (!color.ok) errors.push(...color.error);

  const llm = parseLlmConfig(input.llm);
  if (!llm.ok) errors.push(...prefixErrors("llm", llm.error));

  const skillIds = validateSkillIds(input.skillIds);
  if (!skillIds.ok) errors.push(...skillIds.error);
  const toolGrants = validateToolGrants(input.toolGrants);
  if (!toolGrants.ok) errors.push(...toolGrants.error);

  let schedule: Schedule | null = null;
  if (input.schedule !== undefined) {
    const parsed = parseSchedule(input.schedule);
    if (parsed.ok) schedule = parsed.value;
    else errors.push(...prefixErrors("schedule", parsed.error));
  }

  const supervisorId = validateSupervisor(input.supervisorId, id, ctx);
  if (!supervisorId.ok) errors.push(...supervisorId.error);

  if (
    errors.length > 0 ||
    !name.ok ||
    !role.ok ||
    !color.ok ||
    !llm.ok ||
    !skillIds.ok ||
    !toolGrants.ok ||
    !supervisorId.ok
  ) {
    return err(errors);
  }

  const now = deps.now();
  return ok({
    id,
    officeId: ctx.department.officeId,
    departmentId: ctx.department.id,
    name: name.value,
    role: role.value,
    avatar: input.avatar ?? null,
    color: color.value,
    llm: llm.value,
    skillIds: skillIds.value,
    toolGrants: toolGrants.value,
    schedule,
    supervisorId: supervisorId.value,
    workspaceRef: input.workspaceRef ?? null,
    status: "active",
    statusChangedAt: now,
    createdAt: now,
  });
}

export function transitionEmployee(
  employee: Employee,
  to: EmployeeStatus,
  now: Date,
): Result<Employee> {
  if (employee.status === "terminated") {
    return err([{ path: "status", message: "employee is terminated; termination is final" }]);
  }
  if (employee.status === to) {
    return err([{ path: "status", message: `employee is already ${to}` }]);
  }
  return ok({ ...employee, status: to, statusChangedAt: now });
}

/**
 * Employee: an agent inside a department. Configuration (LLM, skills, tool grants,
 * schedule, supervisor, workspace) plus a status lifecycle:
 *
 *   active <-> paused -> terminated (final)
 *
 * Budget arrives with the telemetry budgets task.
 */
import { validateGrantShape, type ToolGrant } from "../connector/connector.js";
import { normalizeHexColor, type DepartmentId } from "../department/department.js";
import type { OfficeId } from "../office/office.js";
import { parseSchedule, type Schedule } from "../office/schedule.js";
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
import { isPriority, TASK_PRIORITIES, type TaskPriority } from "../task/task.js";
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
  /**
   * This person's standing priority, outranked by their department's and the
   * office's. Lowering it is how somebody is told to yield to their colleagues
   * without touching any of their tasks.
   */
  readonly priority: TaskPriority;
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
  /** Defaults to normal. Loose on the way in, narrow on the entity. */
  readonly priority?: string;
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
  const toolGrants = validateGrantShape(input.toolGrants);
  if (!toolGrants.ok) errors.push(...toolGrants.error);

  let schedule: Schedule | null = null;
  if (input.schedule !== undefined) {
    const parsed = parseSchedule(input.schedule);
    if (parsed.ok) schedule = parsed.value;
    else errors.push(...prefixErrors("schedule", parsed.error));
  }

  const supervisorId = validateSupervisor(input.supervisorId, id, ctx);
  if (!supervisorId.ok) errors.push(...supervisorId.error);

  const priority = input.priority ?? "normal";
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  if (
    errors.length > 0 ||
    !name.ok ||
    !role.ok ||
    !color.ok ||
    !llm.ok ||
    !skillIds.ok ||
    !toolGrants.ok ||
    !supervisorId.ok ||
    !isPriority(priority)
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
    priority,
    status: "active",
    statusChangedAt: now,
    createdAt: now,
  });
}

/**
 * What may be changed about an employee after they are hired. Absent means
 * "leave it alone", which is different from null — null clears a field that can
 * be empty, such as a supervisor or their own working hours.
 */
export interface UpdateEmployeeInput {
  readonly name?: string;
  readonly role?: string;
  readonly avatar?: string | null;
  readonly color?: string;
  readonly llm?: unknown;
  readonly skillIds?: readonly string[];
  readonly toolGrants?: readonly ToolGrant[];
  readonly schedule?: unknown;
  readonly supervisorId?: string | null;
  readonly workspaceRef?: string | null;
  readonly priority?: string;
}

export interface UpdateEmployeeContext {
  /** The supervisor being appointed, resolved by the caller. */
  readonly supervisor: CreateEmployeeContext["supervisor"];
}

/**
 * Applies changes to an employee, validating them exactly as hiring does.
 *
 * Who they are and where they work do not change here: id, office, department,
 * when they joined, and their employment status all carry over. In particular a
 * paused employee stays paused — editing somebody's job title is not a reason
 * to put them back to work, which is what re-running createEmployee would do.
 */
export function updateEmployee(
  employee: Employee,
  changes: UpdateEmployeeInput,
  ctx: UpdateEmployeeContext,
): Result<Employee> {
  const errors: ValidationError[] = [];

  const name = changes.name === undefined ? ok(employee.name) : validateText(changes.name, "name");
  if (!name.ok) errors.push(...name.error);
  const role = changes.role === undefined ? ok(employee.role) : validateText(changes.role, "role");
  if (!role.ok) errors.push(...role.error);
  const color = changes.color === undefined ? ok(employee.color) : normalizeHexColor(changes.color);
  if (!color.ok) errors.push(...color.error);

  const llm = changes.llm === undefined ? ok(employee.llm) : parseLlmConfig(changes.llm);
  if (!llm.ok) errors.push(...prefixErrors("llm", llm.error));

  const skillIds =
    changes.skillIds === undefined ? ok(employee.skillIds) : validateSkillIds(changes.skillIds);
  if (!skillIds.ok) errors.push(...skillIds.error);
  const toolGrants =
    changes.toolGrants === undefined
      ? ok(employee.toolGrants)
      : validateGrantShape(changes.toolGrants);
  if (!toolGrants.ok) errors.push(...toolGrants.error);

  let schedule: Schedule | null = employee.schedule;
  if (changes.schedule === null) schedule = null;
  else if (changes.schedule !== undefined) {
    const parsed = parseSchedule(changes.schedule);
    if (parsed.ok) schedule = parsed.value;
    else errors.push(...prefixErrors("schedule", parsed.error));
  }

  let supervisorId: EmployeeId | null = employee.supervisorId;
  if (changes.supervisorId === null) supervisorId = null;
  else if (changes.supervisorId !== undefined) {
    const validated = validateSupervisor(changes.supervisorId, employee.id, {
      department: { id: employee.departmentId, officeId: employee.officeId },
      supervisor: ctx.supervisor,
    });
    if (validated.ok) supervisorId = validated.value;
    else errors.push(...validated.error);
  }

  const priority = changes.priority ?? employee.priority;
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  if (
    errors.length > 0 ||
    !name.ok ||
    !role.ok ||
    !color.ok ||
    !llm.ok ||
    !skillIds.ok ||
    !toolGrants.ok ||
    !isPriority(priority)
  ) {
    return err(errors);
  }

  return ok({
    ...employee,
    name: name.value,
    role: role.value,
    avatar: changes.avatar === undefined ? employee.avatar : changes.avatar,
    color: color.value,
    llm: llm.value,
    skillIds: skillIds.value,
    toolGrants: toolGrants.value,
    schedule,
    supervisorId,
    workspaceRef: changes.workspaceRef === undefined ? employee.workspaceRef : changes.workspaceRef,
    priority,
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

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
import { parseBudget, type Budget } from "../budget/budget.js";
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
import { isPriority, TASK_PRIORITIES, type TaskPriority } from "../task/task.js";
import { parseLlmConfig, type LlmConfig } from "./llm-config.js";

declare const employeeIdBrand: unique symbol;
export type EmployeeId = string & { readonly [employeeIdBrand]: true };

export const EMPLOYEE_STATUSES = ["active", "paused", "terminated"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export function isEmployeeStatus(value: unknown): value is EmployeeStatus {
  return typeof value === "string" && (EMPLOYEE_STATUSES as readonly string[]).includes(value);
}

/**
 * One piece of work somebody judged good.
 *
 * There is no counter-example on purpose: a model shown a bad example tends to
 * copy it, and "avoid this" belongs in the instructions, where it is said once
 * rather than demonstrated.
 */
export interface WorkExample {
  /** The situation it was good for, in a few words. Null when it is general. */
  readonly when: string | null;
  readonly good: string;
}

/**
 * A draft the real person changed before it went out.
 *
 * Worth more than another twenty samples: it is the one place the office can
 * see what it got wrong about somebody's voice, said by the person themselves.
 */
export interface Correction {
  readonly at: Date;
  /** The work it came from, where there was one. */
  readonly taskId: string | null;
  /** What the office wrote. */
  readonly before: string;
  /** What it should have said. */
  readonly after: string;
}

/**
 * An employee standing in for a real colleague.
 *
 * A voice is personal, so this records consent as much as configuration: who
 * this employee stands in for, who said so, and when. The office can answer for
 * it later, and the canvas says so wherever that work appears.
 *
 * The samples the card was made from are not here. They are documents in this
 * employee's in-tray, where somebody deliberately put them, and they are read
 * once — twenty emails in every prompt would be twenty emails paid for on every
 * call, and the cached prefix would never hold.
 */
export interface Understudy {
  /** The real colleague, by name. */
  readonly person: string;
  /** Who recorded it: a person, never an employee. */
  readonly recordedBy: string;
  readonly recordedAt: Date;
  /** Off keeps the card and uses none of it. */
  readonly enabled: boolean;
  /** What the office learned from the samples. Null until it has studied them. */
  readonly card: string | null;
  readonly cardMadeAt: Date | null;
  /** How many samples it was made from, so a thin card is visible rather than implied. */
  readonly cardFromSamples: number;
  /** What the real person changed, newest first. */
  readonly corrections: readonly Correction[];
}

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
  /** What this person may spend in a period, under their room's and the office's. */
  readonly budget: Budget | null;
  /** Where the work is stored (connector reference). null means the department default. */
  readonly workspaceRef: string | null;
  /**
   * How this person works, in the owner's own words: standing, personal, and
   * true of every piece of work they pick up.
   *
   * Null rather than an empty string, so "nothing written" has one
   * representation — two people with nothing to say are identical, and no empty
   * block can reach a prompt.
   *
   * This is not a skill and not a memory. A skill is a shared procedure with
   * steps; a memory is what this person has learned for themselves. This is what
   * the office told them.
   */
  readonly instructions: string | null;
  /** Work somebody judged good, kept to show what good looks like here. */
  readonly examples: readonly WorkExample[];
  /** The real person this employee stands in for, or null for one that writes as itself. */
  readonly understudy: Understudy | null;
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
  readonly budget?: unknown;
  /** How this person works. Loose on the way in, narrow on the entity. */
  readonly instructions?: unknown;
  readonly examples?: unknown;
  /** Who this person stands in for, if anybody. */
  readonly understudy?: unknown;
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
/** As long as a task's brief: this is a paragraph, not a name. */
export const EMPLOYEE_INSTRUCTIONS_MAX_LENGTH = 20_000;
export const WORK_EXAMPLE_MAX_LENGTH = 4_000;
export const WORK_EXAMPLE_WHEN_MAX_LENGTH = 200;
/** Few, because every one is carried in the prompt of every call this person makes. */
export const MAX_WORK_EXAMPLES = 10;
/** A page, not a corpus: the card is carried in every call this person makes. */
export const STYLE_CARD_MAX_LENGTH = 8_000;
export const PERSON_NAME_MAX_LENGTH = 200;
export const CORRECTION_MAX_LENGTH = 4_000;
/**
 * The ten most recent, oldest dropped. A card made from what somebody corrected
 * last month is worse than one made from fewer, newer answers.
 */
export const MAX_CORRECTIONS = 10;

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

/**
 * A paragraph somebody wrote, or nothing.
 *
 * Capped and otherwise left exactly as typed: the line breaks in it are part of
 * what it says, which is why this is not `validateText` — that one is for a name
 * and a role, trims them, and stops at eighty characters.
 */
function validateInstructions(raw: unknown, path: string): Result<string | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string") return err([{ path, message: "must be a string" }]);
  if (raw.length > EMPLOYEE_INSTRUCTIONS_MAX_LENGTH) {
    return err([
      {
        path,
        message: `must be at most ${String(EMPLOYEE_INSTRUCTIONS_MAX_LENGTH)} characters`,
      },
    ]);
  }
  // Nothing but whitespace is nothing written.
  return ok(raw.trim().length === 0 ? null : raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExamples(raw: unknown): Result<readonly WorkExample[]> {
  if (raw === undefined || raw === null) return ok([]);
  if (!Array.isArray(raw)) {
    return err([{ path: "examples", message: "must be a list of examples" }]);
  }
  if (raw.length > MAX_WORK_EXAMPLES) {
    return err([
      {
        path: "examples",
        message: `must be at most ${String(MAX_WORK_EXAMPLES)}; every one is carried in every call`,
      },
    ]);
  }

  const errors: ValidationError[] = [];
  const examples: WorkExample[] = [];
  raw.forEach((one: unknown, index) => {
    const path = `examples[${String(index)}]`;
    if (!isRecord(one)) {
      errors.push({ path, message: "must be an example with the work in `good`" });
      return;
    }
    const good = one["good"];
    if (typeof good !== "string" || good.trim().length === 0) {
      errors.push({ path: `${path}.good`, message: "must be the work that was good" });
    } else if (good.length > WORK_EXAMPLE_MAX_LENGTH) {
      errors.push({
        path: `${path}.good`,
        message: `must be at most ${String(WORK_EXAMPLE_MAX_LENGTH)} characters`,
      });
    }
    const when = one["when"];
    if (when !== undefined && when !== null && typeof when !== "string") {
      errors.push({ path: `${path}.when`, message: "must be a string" });
    } else if (typeof when === "string" && when.length > WORK_EXAMPLE_WHEN_MAX_LENGTH) {
      errors.push({
        path: `${path}.when`,
        message: `must be at most ${String(WORK_EXAMPLE_WHEN_MAX_LENGTH)} characters`,
      });
    }
    if (typeof good !== "string") return;
    const said = typeof when === "string" ? when.trim() : "";
    examples.push({ when: said.length === 0 ? null : said, good });
  });

  return errors.length > 0 ? err(errors) : ok(examples);
}

function validatePersonName(raw: unknown, path: string): ValidationError[] {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [{ path, message: "is required: an office must be able to say whose voice this is" }];
  }
  return raw.length > PERSON_NAME_MAX_LENGTH
    ? [{ path, message: `must be at most ${String(PERSON_NAME_MAX_LENGTH)} characters` }]
    : [];
}

/**
 * Who this employee stands in for, as the office records it.
 *
 * `recordedBy` is as required as `person`: a voice is personal, and an office
 * that cannot say who agreed to this cannot answer for it later.
 */
function validateUnderstudy(
  raw: unknown,
  existing: Understudy | null,
  now: Date,
): Result<Understudy | null> {
  if (raw === undefined || raw === null) return ok(null);
  if (!isRecord(raw)) {
    return err([{ path: "understudy", message: "must say who this person stands in for" }]);
  }

  const errors: ValidationError[] = [];
  errors.push(...validatePersonName(raw["person"], "understudy.person"));
  errors.push(...validatePersonName(raw["recordedBy"], "understudy.recordedBy"));

  const card = raw["card"];
  if (card !== undefined && card !== null) {
    if (typeof card !== "string") {
      errors.push({ path: "understudy.card", message: "must be a string" });
    } else if (card.length > STYLE_CARD_MAX_LENGTH) {
      errors.push({
        path: "understudy.card",
        message: `must be at most ${String(STYLE_CARD_MAX_LENGTH)} characters`,
      });
    }
  }

  const from = raw["cardFromSamples"];
  if (from !== undefined && (typeof from !== "number" || !Number.isInteger(from) || from < 0)) {
    errors.push({ path: "understudy.cardFromSamples", message: "must be a count of samples" });
  }

  const enabled = raw["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    errors.push({ path: "understudy.enabled", message: "must be true or false" });
  }

  if (errors.length > 0) return err(errors);

  const said = typeof card === "string" && card.trim().length > 0 ? card : null;
  return ok({
    person: (raw["person"] as string).trim(),
    recordedBy: (raw["recordedBy"] as string).trim(),
    // Kept from the record that already exists: studying somebody's samples is
    // not a new act of consent, and must not look like one.
    recordedAt: existing?.recordedAt ?? now,
    enabled: typeof enabled === "boolean" ? enabled : true,
    card: said,
    cardMadeAt: said === null ? null : (asDate(raw["cardMadeAt"]) ?? existing?.cardMadeAt ?? now),
    cardFromSamples: typeof from === "number" ? from : 0,
    corrections: existing?.corrections ?? [],
  });
}

/** A date as it comes back from JSON, or null when it is not one. */
function asDate(raw: unknown): Date | null {
  if (raw instanceof Date) return raw;
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
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

  const budget = parseBudget(input.budget);
  if (!budget.ok) errors.push(...budget.error);

  let schedule: Schedule | null = null;
  if (input.schedule !== undefined) {
    const parsed = parseSchedule(input.schedule);
    if (parsed.ok) schedule = parsed.value;
    else errors.push(...prefixErrors("schedule", parsed.error));
  }

  const supervisorId = validateSupervisor(input.supervisorId, id, ctx);
  if (!supervisorId.ok) errors.push(...supervisorId.error);

  const instructions = validateInstructions(input.instructions, "instructions");
  if (!instructions.ok) errors.push(...instructions.error);
  const examples = validateExamples(input.examples);
  if (!examples.ok) errors.push(...examples.error);
  const understudy = validateUnderstudy(input.understudy, null, deps.now());
  if (!understudy.ok) errors.push(...understudy.error);

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
    !budget.ok ||
    !supervisorId.ok ||
    !instructions.ok ||
    !examples.ok ||
    !understudy.ok ||
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
    budget: budget.value,
    schedule,
    supervisorId: supervisorId.value,
    workspaceRef: input.workspaceRef ?? null,
    instructions: instructions.value,
    examples: examples.value,
    understudy: understudy.value,
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
  readonly budget?: unknown;
  /** Null unteaches somebody; absent leaves what they were told alone. */
  readonly instructions?: string | null;
  readonly examples?: unknown;
  /** Null stops them standing in for anybody, which takes the card with it. */
  readonly understudy?: unknown;
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

  const budget = changes.budget === undefined ? ok(employee.budget) : parseBudget(changes.budget);
  if (!budget.ok) errors.push(...budget.error);

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

  const instructions =
    changes.instructions === undefined
      ? ok(employee.instructions)
      : validateInstructions(changes.instructions, "instructions");
  if (!instructions.ok) errors.push(...instructions.error);

  // Replaced rather than added to: a list editor sends the list it is showing,
  // and merging would make removing one impossible.
  const examples =
    changes.examples === undefined ? ok(employee.examples) : validateExamples(changes.examples);
  if (!examples.ok) errors.push(...examples.error);

  const understudy =
    changes.understudy === undefined
      ? ok(employee.understudy)
      : validateUnderstudy(changes.understudy, employee.understudy, employee.statusChangedAt);
  if (!understudy.ok) errors.push(...understudy.error);

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
    !instructions.ok ||
    !examples.ok ||
    !understudy.ok ||
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
    instructions: instructions.value,
    examples: examples.value,
    understudy: understudy.value,
    priority,
  });
}

export interface CorrectionInput {
  readonly before: string;
  readonly after: string;
  readonly taskId?: string | null;
}

/**
 * Keeps what the real person changed about a draft.
 *
 * Its own function rather than a field on an update, because the rule is a
 * domain rule and not an assignment: the newest goes first and the oldest falls
 * off the end. A card made from what somebody corrected months ago is worse
 * than one made from fewer, newer answers.
 */
export function recordCorrection(
  employee: Employee,
  input: CorrectionInput,
  deps: { readonly now: () => Date },
): Result<Employee> {
  const standing = employee.understudy;
  if (standing === null) {
    return err([
      {
        path: "understudy",
        message: "this person stands in for nobody, so there is no voice to correct",
      },
    ]);
  }

  const errors: ValidationError[] = [];
  for (const [field, value] of [
    ["before", input.before],
    ["after", input.after],
  ] as const) {
    if (typeof value !== "string" || value.trim().length === 0) {
      errors.push({ path: field, message: "is required: a correction is a before and an after" });
    } else if (value.length > CORRECTION_MAX_LENGTH) {
      errors.push({
        path: field,
        message: `must be at most ${String(CORRECTION_MAX_LENGTH)} characters`,
      });
    }
  }
  if (errors.length === 0 && input.before.trim() === input.after.trim()) {
    errors.push({
      path: "after",
      message: "is the same as what was written, so it corrects nothing",
    });
  }
  if (errors.length > 0) return err(errors);

  const correction: Correction = {
    at: deps.now(),
    taskId: input.taskId ?? null,
    before: input.before,
    after: input.after,
  };
  return ok({
    ...employee,
    understudy: {
      ...standing,
      corrections: [correction, ...standing.corrections].slice(0, MAX_CORRECTIONS),
    },
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

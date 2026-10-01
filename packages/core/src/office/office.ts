/**
 * Office: the tenant. Owns the schedule that gates when its employees may work.
 * Budget, memory policy and storage references are added by their own tasks.
 */
import { err, ok, prefixErrors, type Result, type ValidationError } from "../shared/result.js";
import { isPriority, TASK_PRIORITIES, type TaskPriority } from "../task/task.js";
import { parseSchedule, type Schedule } from "./schedule.js";
import { type RunState } from "./run-state.js";
import { parseBudget, type Budget } from "../budget/budget.js";

declare const officeIdBrand: unique symbol;
export type OfficeId = string & { readonly [officeIdBrand]: true };

export interface Office {
  readonly id: OfficeId;
  readonly name: string;
  readonly schedule: Schedule;
  /**
   * The organisation's standing priority, which outranks every level beneath
   * it. Normal by default, so an office that says nothing orders its work
   * exactly as it did before there were levels at all.
   */
  readonly priority: TaskPriority;
  /**
   * Whether this office is working at all. Running unless somebody stopped it,
   * so an office that predates the switch behaves exactly as it always did.
   * Changed through `setRunState`, never through `updateOffice`: renaming an
   * office is not a reason to start it.
   */
  readonly runState: RunState;
  /**
   * What the whole office may spend in a period, or null for no ceiling. The
   * scheduler passes work over when it is reached; nobody is paused, and the
   * period rolling puts it back.
   */
  readonly budget: Budget | null;
  /** Incremented on every configuration change; snapshots key off it. */
  readonly configVersion: number;
  readonly createdAt: Date;
}

export interface CreateOfficeInput {
  readonly name: string;
  /** Unvalidated; absent means no ceiling. */
  readonly budget?: unknown;
  /** Defaults to 24/7. Accepts unvalidated input (e.g. from YAML or the API). */
  readonly schedule?: unknown;
  /** Defaults to normal. Loose on the way in, narrow on the entity. */
  readonly priority?: string;
}

/** Absent means leave alone; there is no way to unset a field here. */
export interface UpdateOfficeInput {
  readonly name?: string;
  readonly budget?: unknown;
  readonly schedule?: unknown;
  readonly priority?: string;
}

export interface OfficeDeps {
  readonly id: () => OfficeId;
  readonly now: () => Date;
}

export const OFFICE_NAME_MAX_LENGTH = 100;

export function validateOfficeName(raw: unknown): Result<string> {
  if (typeof raw !== "string") return err([{ path: "name", message: "must be a string" }]);
  const name = raw.trim();
  if (name.length === 0) return err([{ path: "name", message: "must not be empty" }]);
  if (name.length > OFFICE_NAME_MAX_LENGTH) {
    return err([
      { path: "name", message: `must be at most ${String(OFFICE_NAME_MAX_LENGTH)} characters` },
    ]);
  }
  return ok(name);
}

export function createOffice(input: CreateOfficeInput, deps: OfficeDeps): Result<Office> {
  const errors: ValidationError[] = [];

  const name = validateOfficeName(input.name);
  if (!name.ok) errors.push(...name.error);

  const schedule = parseSchedule(input.schedule ?? { kind: "always" });
  if (!schedule.ok) errors.push(...prefixErrors("schedule", schedule.error));

  const priority = input.priority ?? "normal";
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  const budget = parseBudget(input.budget);
  if (!budget.ok) errors.push(...budget.error);

  if (errors.length > 0 || !name.ok || !schedule.ok || !isPriority(priority) || !budget.ok) {
    return err(errors);
  }

  return ok({
    id: deps.id(),
    name: name.value,
    schedule: schedule.value,
    priority,
    runState: "running",
    budget: budget.value,
    configVersion: 1,
    createdAt: deps.now(),
  });
}

/**
 * Changes an office, keeping it the same office.
 *
 * Identity, creation time and the configuration version carry over untouched:
 * the version belongs to whatever store is recording the change, and an entity
 * that bumped its own would collide with the snapshot that follows it.
 */
export function updateOffice(office: Office, changes: UpdateOfficeInput): Result<Office> {
  const errors: ValidationError[] = [];

  const name = changes.name === undefined ? ok(office.name) : validateOfficeName(changes.name);
  if (!name.ok) errors.push(...name.error);

  const schedule =
    changes.schedule === undefined ? ok(office.schedule) : parseSchedule(changes.schedule);
  if (!schedule.ok) errors.push(...prefixErrors("schedule", schedule.error));

  const priority = changes.priority ?? office.priority;
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  const budget = changes.budget === undefined ? ok(office.budget) : parseBudget(changes.budget);
  if (!budget.ok) errors.push(...budget.error);

  if (errors.length > 0 || !name.ok || !schedule.ok || !isPriority(priority) || !budget.ok) {
    return err(errors);
  }

  return ok({
    ...office,
    name: name.value,
    schedule: schedule.value,
    priority,
    budget: budget.value,
  });
}

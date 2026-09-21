/**
 * Task: a unit of work with a state machine and full transition history.
 *
 *   backlog -> assigned -> in_progress -> in_review -> (changes_requested -> in_progress)* -> approved -> done
 *
 * Side states: blocked, escalated, transferred; terminal: done, cancelled.
 * Every transition appends exactly one history event.
 */
import type { DepartmentId } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { err, ok, type Result, type ValidationError } from "../shared/result.js";

declare const taskIdBrand: unique symbol;
export type TaskId = string & { readonly [taskIdBrand]: true };

export const TASK_STATUSES = [
  "backlog",
  "assigned",
  "in_progress",
  "in_review",
  "changes_requested",
  "approved",
  "done",
  "blocked",
  "escalated",
  "transferred",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  backlog: ["assigned", "cancelled"],
  assigned: ["in_progress", "backlog", "blocked", "transferred", "cancelled"],
  in_progress: ["in_review", "done", "blocked", "escalated", "transferred", "cancelled"],
  in_review: ["approved", "changes_requested", "escalated", "cancelled"],
  changes_requested: ["in_progress", "escalated", "transferred", "cancelled"],
  approved: ["done"],
  blocked: ["assigned", "in_progress", "escalated", "transferred", "cancelled"],
  escalated: ["assigned", "in_progress", "transferred", "cancelled"],
  transferred: ["assigned", "cancelled"],
  done: [],
  cancelled: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskEvent {
  readonly at: Date;
  readonly from: TaskStatus | null;
  readonly to: TaskStatus;
  /** Employee or human who caused the transition; null for system/creation. */
  readonly actorId: EmployeeId | null;
  readonly reason: string | null;
}

export interface Task {
  readonly id: TaskId;
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly title: string;
  readonly brief: string;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly assigneeId: EmployeeId | null;
  readonly reviewerIds: readonly EmployeeId[];
  readonly dependsOn: readonly TaskId[];
  /** References to produced artifacts (workspace paths, commit ids, document ids). */
  readonly artifacts: readonly string[];
  readonly tokenBudget: number | null;
  readonly deadline: Date | null;
  readonly history: readonly TaskEvent[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateTaskInput {
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly title: string;
  readonly brief?: string;
  readonly priority?: string;
  readonly assigneeId?: EmployeeId;
  readonly reviewerIds?: readonly EmployeeId[];
  readonly dependsOn?: readonly string[];
  readonly tokenBudget?: number;
  readonly deadline?: Date;
}

export interface TaskDeps {
  readonly id: () => TaskId;
  readonly now: () => Date;
}

export interface TransitionOptions {
  readonly at: Date;
  readonly actorId: EmployeeId | null;
  readonly reason?: string;
  /** New assignee when moving into `assigned` (required if the task has none). */
  readonly assigneeId?: EmployeeId;
}

export const TASK_TITLE_MAX_LENGTH = 200;
export const TASK_BRIEF_MAX_LENGTH = 20_000;

function isPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (TASK_PRIORITIES as readonly string[]).includes(v);
}

function uniqueIds(ids: readonly string[], path: string, label: string): ValidationError[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return [{ path, message: `duplicate ${label} "${id}"` }];
    seen.add(id);
  }
  return [];
}

export function createTask(input: CreateTaskInput, deps: TaskDeps): Result<Task> {
  const errors: ValidationError[] = [];
  const id = deps.id();

  const title = input.title.trim();
  if (title.length === 0) errors.push({ path: "title", message: "must not be empty" });
  else if (title.length > TASK_TITLE_MAX_LENGTH) {
    errors.push({
      path: "title",
      message: `must be at most ${String(TASK_TITLE_MAX_LENGTH)} characters`,
    });
  }

  const brief = input.brief ?? "";
  if (brief.length > TASK_BRIEF_MAX_LENGTH) {
    errors.push({
      path: "brief",
      message: `must be at most ${String(TASK_BRIEF_MAX_LENGTH)} characters`,
    });
  }

  const priority = input.priority ?? "normal";
  if (!isPriority(priority)) {
    errors.push({ path: "priority", message: `must be one of ${TASK_PRIORITIES.join(", ")}` });
  }

  const assigneeId = input.assigneeId ?? null;
  const reviewerIds = input.reviewerIds ?? [];
  errors.push(...uniqueIds(reviewerIds, "reviewerIds", "reviewer"));
  if (assigneeId !== null && reviewerIds.includes(assigneeId)) {
    errors.push({ path: "reviewerIds", message: "an employee cannot review their own work" });
  }

  const dependsOn = input.dependsOn ?? [];
  if (dependsOn.includes(id))
    errors.push({ path: "dependsOn", message: "a task cannot depend on itself" });
  errors.push(...uniqueIds(dependsOn, "dependsOn", "dependency"));

  const tokenBudget = input.tokenBudget ?? null;
  if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
    errors.push({ path: "tokenBudget", message: "must be a positive integer" });
  }

  const deadline = input.deadline ?? null;
  if (deadline !== null && Number.isNaN(deadline.getTime())) {
    errors.push({ path: "deadline", message: "must be a valid date" });
  }

  if (errors.length > 0 || !isPriority(priority)) return err(errors);

  const now = deps.now();
  const status: TaskStatus = assigneeId === null ? "backlog" : "assigned";
  return ok({
    id,
    officeId: input.officeId,
    departmentId: input.departmentId,
    title,
    brief,
    priority,
    status,
    assigneeId,
    reviewerIds: [...reviewerIds],
    dependsOn: [...dependsOn] as TaskId[],
    artifacts: [],
    tokenBudget,
    deadline,
    history: [{ at: now, from: null, to: status, actorId: null, reason: null }],
    createdAt: now,
    updatedAt: now,
  });
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function transitionTask(
  task: Task,
  to: TaskStatus,
  options: TransitionOptions,
): Result<Task> {
  if (!canTransition(task.status, to)) {
    const reason = TERMINAL_TASK_STATUSES.includes(task.status)
      ? `task is ${task.status}, which is final`
      : `cannot move a task from ${task.status} to ${to}`;
    return err([{ path: "status", message: reason }]);
  }

  let assigneeId = task.assigneeId;
  if (to === "assigned") {
    assigneeId = options.assigneeId ?? task.assigneeId;
    if (assigneeId === null) {
      return err([
        { path: "assigneeId", message: "an assignee is required to move a task to assigned" },
      ]);
    }
  } else if (to === "backlog") {
    assigneeId = null;
  }

  const event: TaskEvent = {
    at: options.at,
    from: task.status,
    to,
    actorId: options.actorId,
    reason: options.reason ?? null,
  };
  return ok({
    ...task,
    status: to,
    assigneeId,
    history: [...task.history, event],
    updatedAt: options.at,
  });
}

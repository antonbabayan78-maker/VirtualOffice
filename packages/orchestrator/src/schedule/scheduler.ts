/**
 * Event-driven scheduler (plan §3 (11), §6.1).
 *
 * A tick answers one question: what work is due right now? It costs O(due work)
 * and nothing else — no model is asked anything, no agent is woken to be told
 * there is nothing to do. An office of eighty idle employees costs a tick that
 * enqueues nothing, which is what "zero idle cost" has to mean if running an
 * office around the clock is to be affordable.
 *
 * The tick is pure: it reads a snapshot and returns the jobs to enqueue, the
 * recurring occurrences that fired and why anything was passed over. Loading the
 * snapshot and persisting what fired belong to the worker, so a scheduler tick
 * can be tested to the minute without a database.
 *
 * Three levels of hours gate the work: the office's, the department's and the
 * employee's own. All three must be open, because an employee cannot work while
 * their office is shut.
 */
import {
  isOpen,
  type DepartmentId,
  type EmployeeId,
  type EmployeeStatus,
  type OfficeId,
  type Schedule,
  type TaskId,
  type TaskPriority,
  type TaskStatus,
} from "@vo/core";
import type { JobQueue, JobSpec } from "../queue/types.js";
import { nextCronRun, parseCron } from "./cron.js";

export interface ScheduledOffice {
  readonly id: OfficeId;
  readonly schedule: Schedule;
}

export interface ScheduledDepartment {
  readonly id: DepartmentId;
  readonly officeId: OfficeId;
  readonly schedule: Schedule;
}

export interface ScheduledEmployee {
  readonly id: EmployeeId;
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly status: EmployeeStatus;
  readonly schedule: Schedule;
}

export interface RunnableTask {
  readonly id: TaskId;
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly assigneeId: EmployeeId | null;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  /** When the task last changed. Ticks that change nothing enqueue nothing. */
  readonly lastEventAt: number;
}

export interface RecurringJob {
  readonly id: string;
  readonly officeId: OfficeId;
  readonly departmentId?: DepartmentId;
  readonly employeeId?: EmployeeId;
  readonly cron: string;
  /** Defaults to the office's own timezone where it has one, else UTC. */
  readonly timezone?: string;
  readonly kind: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly priority?: number;
  /** When this last fired; null for a definition that never has. */
  readonly lastRunAt: number | null;
}

export interface SchedulerSnapshot {
  readonly offices: readonly ScheduledOffice[];
  readonly departments: readonly ScheduledDepartment[];
  readonly employees: readonly ScheduledEmployee[];
  readonly tasks: readonly RunnableTask[];
  readonly recurring: readonly RecurringJob[];
}

export type SkipReason =
  | "office_closed"
  | "department_closed"
  | "employee_closed"
  | "employee_unavailable"
  | "unassigned"
  | "not_due"
  | "unknown_office"
  | "unknown_department"
  | "unknown_employee"
  | "bad_cron";

export interface SkippedWork {
  /** What was passed over: a task id or a recurring definition id. */
  readonly what: string;
  readonly reason: SkipReason;
  readonly detail?: string;
}

export interface DueWork {
  readonly jobs: readonly JobSpec[];
  /** Occurrences that fired, for the caller to record as the new lastRunAt. */
  readonly recurringFired: readonly { readonly id: string; readonly dueAt: number }[];
  readonly skipped: readonly SkippedWork[];
}

/** Statuses where the next move belongs to the agent. */
const AGENT_TURN: readonly TaskStatus[] = ["assigned", "in_progress"];

const JOB_PRIORITY: Readonly<Record<TaskPriority, number>> = {
  low: 0,
  normal: 10,
  high: 20,
  urgent: 30,
};

export const AGENT_RUN_JOB = "agent_run";

interface Closure {
  readonly reason: SkipReason;
  readonly detail?: string;
}

/** The first level of hours that is shut, or null when the work may go ahead. */
function closedBecause(
  now: Date,
  office: ScheduledOffice | undefined,
  department: ScheduledDepartment | undefined,
  employee: ScheduledEmployee | undefined,
): Closure | null {
  if (office === undefined) return { reason: "unknown_office" };
  if (!isOpen(office.schedule, now)) return { reason: "office_closed" };
  if (department !== undefined && !isOpen(department.schedule, now)) {
    return { reason: "department_closed" };
  }
  if (employee !== undefined) {
    if (employee.status !== "active") {
      return { reason: "employee_unavailable", detail: employee.status };
    }
    if (!isOpen(employee.schedule, now)) return { reason: "employee_closed" };
  }
  return null;
}

export function computeDueWork(snapshot: SchedulerSnapshot, now: Date): DueWork {
  const offices = new Map(snapshot.offices.map((o) => [o.id as string, o]));
  const departments = new Map(snapshot.departments.map((d) => [d.id as string, d]));
  const employees = new Map(snapshot.employees.map((e) => [e.id as string, e]));

  const jobs: JobSpec[] = [];
  const skipped: SkippedWork[] = [];
  const recurringFired: { id: string; dueAt: number }[] = [];

  for (const task of snapshot.tasks) {
    if (!AGENT_TURN.includes(task.status)) continue;
    if (task.assigneeId === null) {
      skipped.push({ what: task.id, reason: "unassigned" });
      continue;
    }
    const employee = employees.get(task.assigneeId);
    if (employee === undefined) {
      skipped.push({ what: task.id, reason: "unknown_employee", detail: task.assigneeId });
      continue;
    }
    const closed = closedBecause(
      now,
      offices.get(task.officeId),
      departments.get(task.departmentId),
      employee,
    );
    if (closed !== null) {
      skipped.push({ what: task.id, ...closed });
      continue;
    }

    jobs.push({
      officeId: task.officeId,
      employeeId: task.assigneeId,
      kind: AGENT_RUN_JOB,
      payload: { taskId: task.id, departmentId: task.departmentId },
      priority: JOB_PRIORITY[task.priority],
      // Keyed by the task's last change, so ticking twice queues one run, and a
      // task that moves on genuinely earns another.
      idempotencyKey: `${AGENT_RUN_JOB}:${task.id}:${String(task.lastEventAt)}`,
    });
  }

  for (const recurring of snapshot.recurring) {
    const expr = parseCron(recurring.cron);
    if (!expr.ok) {
      skipped.push({
        what: recurring.id,
        reason: "bad_cron",
        detail: expr.error[0]?.message ?? recurring.cron,
      });
      continue;
    }

    const office = offices.get(recurring.officeId);
    const department =
      recurring.departmentId === undefined ? undefined : departments.get(recurring.departmentId);
    const employee =
      recurring.employeeId === undefined ? undefined : employees.get(recurring.employeeId);
    if (recurring.departmentId !== undefined && department === undefined) {
      skipped.push({ what: recurring.id, reason: "unknown_department" });
      continue;
    }
    if (recurring.employeeId !== undefined && employee === undefined) {
      skipped.push({ what: recurring.id, reason: "unknown_employee" });
      continue;
    }

    // A definition that has never run waits for its own next minute rather than
    // firing at whatever time the office happened to tick first.
    const since = recurring.lastRunAt ?? now.getTime() - 60_000;
    let dueAt: Date;
    try {
      dueAt = nextCronRun(expr.value, new Date(since), recurring.timezone ?? "UTC");
    } catch (error) {
      skipped.push({
        what: recurring.id,
        reason: "bad_cron",
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (dueAt.getTime() > now.getTime()) {
      skipped.push({ what: recurring.id, reason: "not_due" });
      continue;
    }

    const closed = closedBecause(now, office, department, employee);
    if (closed !== null) {
      // Still due: the occurrence is not recorded, so it fires when hours resume.
      skipped.push({ what: recurring.id, ...closed });
      continue;
    }

    jobs.push({
      officeId: recurring.officeId,
      ...(recurring.employeeId === undefined ? {} : { employeeId: recurring.employeeId }),
      kind: recurring.kind,
      payload: { ...recurring.payload, recurringId: recurring.id, dueAt: dueAt.getTime() },
      priority: recurring.priority ?? 0,
      // One job per occurrence however many ticks see it.
      idempotencyKey: `recurring:${recurring.id}:${String(dueAt.getTime())}`,
    });
    recurringFired.push({ id: recurring.id, dueAt: dueAt.getTime() });
  }

  return { jobs, recurringFired, skipped };
}

export interface EnqueueSummary extends DueWork {
  readonly enqueued: number;
  readonly deduplicated: number;
}

/** Computes a tick and puts it on the queue. The queue decides what is a repeat. */
export async function enqueueDueWork(
  queue: JobQueue,
  snapshot: SchedulerSnapshot,
  now: Date,
): Promise<EnqueueSummary> {
  const due = computeDueWork(snapshot, now);
  let enqueued = 0;
  let deduplicated = 0;
  for (const spec of due.jobs) {
    const result = await queue.enqueue(spec);
    if (result.deduplicated) deduplicated += 1;
    else enqueued += 1;
  }
  return { ...due, enqueued, deduplicated };
}

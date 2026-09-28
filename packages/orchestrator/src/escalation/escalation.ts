/**
 * Escalation rules (plan §3 (9)).
 *
 * Work escalates when a review will not converge, when nothing has moved for
 * too long, or when a run spent its budget. Who it escalates *to* follows the
 * office's own shape: the assignee's supervisor first, then the department's
 * escalates_to edges, and the owner when the chain runs out. An office that has
 * drawn no escalation path still escalates — to the owner — because the failure
 * mode to avoid is work quietly going nowhere.
 *
 * Resolution is pure and total. It skips anyone not active, refuses to walk in
 * circles even though the domain model forbids them, and gives up at the owner
 * after a sensible number of hops rather than hunting forever.
 */
import type {
  Connection,
  DepartmentId,
  EmployeeId,
  EmployeeStatus,
  Result,
  Task,
  TaskStatus,
} from "@vo/core";
import {
  applyTransition,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowOutcome,
} from "../workflow/workflow-types.js";

/** Enough rungs for any real office; past this something is wrong with the graph. */
export const MAX_ESCALATION_HOPS = 8;

export interface EscalationEmployee {
  readonly id: EmployeeId;
  readonly departmentId: DepartmentId;
  readonly supervisorId: EmployeeId | null;
  readonly status: EmployeeStatus;
}

export interface EscalationGraph {
  readonly employees: readonly EscalationEmployee[];
  readonly connections: readonly Connection[];
}

export type EscalationTarget =
  | { readonly kind: "employee"; readonly employeeId: EmployeeId; readonly hops: number }
  | { readonly kind: "department"; readonly departmentId: DepartmentId; readonly hops: number }
  | { readonly kind: "owner"; readonly hops: number };

export type EscalationTrigger =
  | { readonly kind: "review_rounds"; readonly rounds: number; readonly limit: number }
  | { readonly kind: "no_progress"; readonly idleMs: number; readonly limitMs: number }
  | { readonly kind: "budget"; readonly detail: string }
  | { readonly kind: "check_error"; readonly checkId: string; readonly detail: string };

export interface EscalationRules {
  /** Escalate when nothing has happened for this long. Null leaves it to a human. */
  readonly noProgressMs: number | null;
}

export const DEFAULT_ESCALATION_RULES: EscalationRules = { noProgressMs: null };

/** Statuses where somebody is waiting for something to happen. */
const WATCHED: readonly TaskStatus[] = [
  "assigned",
  "in_progress",
  "in_review",
  "changes_requested",
  "blocked",
];

export interface EscalationFrom {
  readonly employeeId: EmployeeId | null;
  readonly departmentId: DepartmentId;
}

export function resolveEscalationTarget(
  graph: EscalationGraph,
  from: EscalationFrom,
  options: { readonly maxHops?: number } = {},
): EscalationTarget {
  const maxHops = options.maxHops ?? MAX_ESCALATION_HOPS;
  const byId = new Map(graph.employees.map((e) => [e.id as string, e]));

  // Up the reporting line first: the nearest person who can actually act.
  let hops = 0;
  const seenPeople = new Set<string>();
  let current = from.employeeId === null ? undefined : byId.get(from.employeeId);
  if (current !== undefined) seenPeople.add(current.id);
  while (current?.supervisorId != null && hops < maxHops) {
    const supervisorId: EmployeeId = current.supervisorId;
    if (seenPeople.has(supervisorId)) break;
    seenPeople.add(supervisorId);
    hops += 1;
    const supervisor = byId.get(supervisorId);
    if (supervisor === undefined) break;
    if (supervisor.status === "active") {
      return { kind: "employee", employeeId: supervisorId, hops };
    }
    current = supervisor;
  }

  // Then along the department escalation edges, deepest first.
  const edges = graph.connections.filter((c) => c.kind === "escalates_to");
  const seenDepartments = new Set<string>([from.departmentId]);
  let department: DepartmentId = from.departmentId;
  let departmentHops = 0;
  let found: DepartmentId | null = null;
  while (departmentHops < maxHops) {
    const next = edges
      .filter((edge) => edge.fromId === department)
      .map((edge) => edge.toId)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
    if (next === undefined) break;
    if (seenDepartments.has(next)) return { kind: "owner", hops: 0 };
    seenDepartments.add(next);
    department = next;
    departmentHops += 1;
    found = next;
  }
  if (found !== null) return { kind: "department", departmentId: found, hops: departmentHops };

  return { kind: "owner", hops: 0 };
}

/** When the task last moved, which is what "no progress" is measured from. */
export function lastProgressAt(task: Task): number {
  const last = task.history.at(-1);
  return last?.at.getTime() ?? 0;
}

export function checkNoProgress(
  task: Task,
  rules: EscalationRules,
  now: Date,
): EscalationTrigger | null {
  const limitMs = rules.noProgressMs;
  if (limitMs === null) return null;
  if (!WATCHED.includes(task.status)) return null;
  const idleMs = now.getTime() - lastProgressAt(task);
  if (idleMs < limitMs) return null;
  return { kind: "no_progress", idleMs, limitMs };
}

export interface StaleTask {
  readonly task: Task;
  readonly trigger: EscalationTrigger;
}

/** The tasks a tick should escalate because nothing has happened to them. */
export function staleTasks(
  tasks: readonly Task[],
  rules: EscalationRules,
  now: Date,
): readonly StaleTask[] {
  const stale: StaleTask[] = [];
  for (const task of tasks) {
    const trigger = checkNoProgress(task, rules, now);
    if (trigger !== null) stale.push({ task, trigger });
  }
  return stale;
}

/** A line a person can act on, for the notification and the task history. */
export function describeTrigger(trigger: EscalationTrigger): string {
  switch (trigger.kind) {
    case "review_rounds":
      return `escalated after ${String(trigger.limit)} review rounds without approval`;
    case "no_progress": {
      const minutes = Math.round(trigger.idleMs / 60_000);
      return `escalated after ${String(minutes)} minutes with no progress`;
    }
    case "budget":
      return `escalated after the run budget was spent: ${trigger.detail}`;
    case "check_error":
      return `check "${trigger.checkId}" could not run: ${trigger.detail}`;
  }
}

export function describeTarget(target: EscalationTarget): string {
  switch (target.kind) {
    case "employee":
      return `employee ${target.employeeId}`;
    case "department":
      return `department ${target.departmentId}`;
    case "owner":
      return "the office owner";
  }
}

/**
 * Moves a task to escalated, naming the trigger and the person or department it
 * lands on. Any rung of the recovery ladder ends here when it runs out of
 * options, so the shape of an escalation is decided once.
 */
export function escalateTask(
  task: Task,
  trigger: EscalationTrigger,
  event: WorkflowEvent,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const target =
    context.escalationGraph === undefined
      ? ({ kind: "owner", hops: 0 } as const)
      : resolveEscalationTarget(context.escalationGraph, {
          employeeId: task.assigneeId,
          departmentId: task.departmentId,
        });

  const reason = describeTrigger(trigger);
  return applyTransition(
    task,
    "escalated",
    event,
    context,
    [
      { type: "escalate", reason, to: target },
      {
        // A department has no inbox of its own; its people hear about it as the
        // owner's escalation until one of them picks the work up.
        type: "notify",
        audience: target.kind === "employee" ? "supervisor" : "owner",
        message: `task "${task.title}" ${reason}; now with ${describeTarget(target)}`,
      },
    ],
    reason,
  );
}

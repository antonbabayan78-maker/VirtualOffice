/**
 * What an office is waiting on a person for.
 *
 * Three things, and they are not the same kind of thing. A department can hold
 * **finished work** until somebody signs it off. A run can be holding **one
 * call** it may not make until somebody says so. And work can simply have
 * **stopped** — escalated, or blocked on something — which is not a decision at
 * all, but is still a person's to deal with and belongs in the same place.
 *
 * Pure, and given what it needs rather than reaching for it: the held calls
 * come from wherever the checkpoints are kept, which is the office's business
 * and not this module's. The same arrangement as `judgeableContests`.
 *
 * Oldest first. The inbox is read from the top, and the thing that has been
 * waiting longest is the thing to answer.
 */
import type {
  Department,
  GatedAction,
  ReviewPolicy,
  Task,
  TaskId,
  DepartmentId,
  EmployeeId,
} from "@vo/core";
import type { HeldCall } from "./workflow-types.js";

/**
 * What this department holds of this work: the overlap between the categories
 * it gates and the ones the work actually involved, in the department's own
 * order, which is the order it is read out in.
 *
 * Recomputed rather than read back off an effect: an effect says what was asked
 * once, not what is still outstanding after a rejection and a redo.
 */
export function gatesAwaiting(task: Task, policy: ReviewPolicy): readonly GatedAction[] {
  if (policy.kind !== "gate") return [];
  return policy.gatedActions.filter((gate) => task.gatedActions.includes(gate));
}

interface WaitingBase {
  readonly taskId: TaskId;
  readonly title: string;
  readonly departmentId: DepartmentId;
  readonly assigneeId: EmployeeId | null;
  /** When this started waiting. */
  readonly since: Date;
}

export type Waiting =
  | (WaitingBase & {
      readonly kind: "call";
      /** The call, as the run named it; a decision is about this and nothing else. */
      readonly key: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
      readonly gates: readonly GatedAction[];
      readonly detail: string;
    })
  | (WaitingBase & { readonly kind: "review"; readonly gates: readonly GatedAction[] })
  | (WaitingBase & {
      readonly kind: "stopped";
      readonly status: "blocked" | "escalated";
      /** Why, as the office recorded it, or null when it said nothing. */
      readonly reason: string | null;
    });

/** Why a task last moved, which for stopped work is why it stopped. */
function lastReason(task: Task): string | null {
  return task.history.at(-1)?.reason ?? null;
}

function base(task: Task): WaitingBase {
  return {
    taskId: task.id,
    title: task.title,
    departmentId: task.departmentId,
    assigneeId: task.assigneeId,
    since: task.updatedAt,
  };
}

export function whatIsWaiting(
  tasks: readonly Task[],
  departments: readonly Department[],
  held: ReadonlyMap<string, readonly HeldCall[]>,
): readonly Waiting[] {
  const policies = new Map(
    departments.map((department) => [department.id as string, department.reviewPolicy]),
  );
  const waiting: Waiting[] = [];

  for (const task of tasks) {
    if (task.status === "in_review") {
      const policy = policies.get(task.departmentId);
      // A department this office cannot read holds nothing: there is no policy
      // to say what it gates, and inventing one would put work in front of
      // somebody with nothing to decide about.
      if (policy === undefined) continue;
      const gates = gatesAwaiting(task, policy);
      if (gates.length > 0) waiting.push({ ...base(task), kind: "review", gates });
      continue;
    }

    if (task.status === "blocked") {
      const calls = held.get(task.id) ?? [];
      for (const call of calls) {
        waiting.push({
          ...base(task),
          kind: "call",
          key: call.key,
          name: call.name,
          input: call.input,
          gates: call.gates,
          detail: call.detail,
        });
      }
      // Blocked on something else: not a decision, and still somebody's to deal
      // with. Its department does not come into it.
      if (calls.length === 0) {
        waiting.push({
          ...base(task),
          kind: "stopped",
          status: "blocked",
          reason: lastReason(task),
        });
      }
      continue;
    }

    if (task.status === "escalated") {
      waiting.push({
        ...base(task),
        kind: "stopped",
        status: "escalated",
        reason: lastReason(task),
      });
    }
  }

  return waiting.sort((a, b) => a.since.getTime() - b.since.getTime());
}

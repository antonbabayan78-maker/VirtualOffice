/**
 * Four levels of priority, packed into the one number a queue can sort by.
 *
 * An office decides before a department, a department before an employee, an
 * employee before the task itself — so a decision taken for the organisation
 * cannot be overturned from below. The comparison is lexicographic rather than
 * additive on purpose: if the levels merely added up, a department could
 * out-vote the organisation by setting a big enough number, which is exactly
 * what "the organisation decides first" has to rule out.
 *
 * It is packed rather than compared as a tuple because `JobSpec.priority` is a
 * single number and that contract is published — every queue adapter is tested
 * against it. Packing keeps the precedence entirely inside the scheduler and
 * asks nothing of the queue.
 *
 * Base ten, one digit per level, so a key is legible in a log: 3210 is an
 * urgent organisation, a high department, an ordinary employee and a task
 * nobody is in a hurry about. `PRIORITY_RANK` stays below ten for this reason.
 *
 * Every level defaults to normal, so an office that sets nothing produces the
 * same key for every job and ordering falls through to the queue's own
 * tie-breaks, exactly as it did before any of this existed.
 */
import { PRIORITY_RANK, type TaskPriority } from "@vo/core";

export interface PriorityLevels {
  readonly office: TaskPriority;
  readonly department: TaskPriority;
  readonly employee: TaskPriority;
  readonly task: TaskPriority;
}

/**
 * What each level is worth. Each step is ten times the one below, which is what
 * makes the order strict: everything the levels beneath can express together
 * still fits inside a single step of the level above.
 */
export const LEVEL_WEIGHT: Readonly<Record<keyof PriorityLevels, number>> = {
  office: 1000,
  department: 100,
  employee: 10,
  task: 1,
};

export function orderingKey(levels: PriorityLevels): number {
  return (
    PRIORITY_RANK[levels.office] * LEVEL_WEIGHT.office +
    PRIORITY_RANK[levels.department] * LEVEL_WEIGHT.department +
    PRIORITY_RANK[levels.employee] * LEVEL_WEIGHT.employee +
    PRIORITY_RANK[levels.task] * LEVEL_WEIGHT.task
  );
}

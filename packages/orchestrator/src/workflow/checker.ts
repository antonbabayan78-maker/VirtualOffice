/**
 * A department that has to look at another's work before it is done.
 *
 * QA passes before Engineering ships. That is a review, but it does not belong
 * inside Engineering's own policy: the department doing the checking is not the
 * one doing the work, and Engineering should not be able to decide it no longer
 * needs checking. So it lives on the arrow between them.
 *
 * It runs after the department's own review, not instead of it. A
 * manager-reviewed department gets its manager and then the checker; a
 * department that reviews nothing at all still gets the checker.
 *
 * The task records who has signed off. Without that memory the work would
 * bounce between done and review forever, since every approval would find the
 * same check still outstanding.
 */
import type { Connection, DepartmentId, EmployeeId, Task } from "@vo/core";
import { rankPeers } from "./peer-policy.js";
import type { WorkflowContext } from "./workflow-types.js";

export interface PendingCheck {
  readonly departmentId: DepartmentId;
  readonly reviewerId: EmployeeId;
  readonly connectionId: Connection["id"];
}

/** Arrows saying "this department checks that one's work", in a stable order. */
function checkersOf(task: Task, context: WorkflowContext): readonly Connection[] {
  return (context.escalationGraph?.connections ?? []).filter(
    (connection) =>
      connection.kind === "reviews" &&
      connection.enabled &&
      connection.toId === task.departmentId &&
      // A department checking its own work is the department's own policy, and
      // this is not that.
      connection.fromId !== task.departmentId,
  );
}

/**
 * Who still has to look at this, or null when nobody does.
 *
 * Taken one at a time: several departments may check the same work, and each
 * signs before the next is asked, so the order they answer in is the order the
 * office drew them.
 */
export function checkerFor(task: Task, context: WorkflowContext): PendingCheck | null {
  const colleagues = context.colleagues ?? [];
  for (const connection of checkersOf(task, context)) {
    if (task.checkedBy.includes(connection.fromId)) continue;

    const there = colleagues.filter((candidate) => candidate.departmentId === connection.fromId);
    // A department with nobody in it cannot check anything, and work must not
    // wait forever somewhere nobody will ever look.
    const reviewer = rankPeers(there, { assigneeId: task.assigneeId, reviewSkills: [] })[0];
    if (reviewer === undefined) continue;

    return {
      departmentId: connection.fromId,
      reviewerId: reviewer.id,
      connectionId: connection.id,
    };
  }
  return null;
}

/** The signatures this task should carry once this person has approved it. */
export function signedOffBy(
  task: Task,
  actorId: EmployeeId | null,
  context: WorkflowContext,
): readonly DepartmentId[] {
  if (actorId === null) return task.checkedBy;
  const actor = (context.colleagues ?? []).find((candidate) => candidate.id === actorId);
  if (actor === undefined) return task.checkedBy;

  const checks = checkersOf(task, context).some(
    (connection) => connection.fromId === actor.departmentId,
  );
  if (!checks || task.checkedBy.includes(actor.departmentId)) return task.checkedBy;
  return [...task.checkedBy, actor.departmentId];
}

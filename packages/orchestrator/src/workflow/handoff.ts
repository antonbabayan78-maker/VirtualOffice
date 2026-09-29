/**
 * Work crossing a departmental boundary.
 *
 * A department finishing something is, in a real office, the moment the next
 * department's work begins. The connections already say who hands off to whom
 * and are already drawn on the canvas; this is what reads them.
 *
 * The engine emits and creates nothing. A handoff comes back as data — where
 * the work goes, what it is, what it is carrying, and who should take it — and
 * whoever is holding a store performs it. That is what keeps the engine
 * testable to the minute without a database, and it is why a handoff can be
 * reported when it cannot be placed instead of half-happening.
 *
 * What travels is the brief, the artifacts and the documents the work produced.
 * Not the transcript: that is the department's own working, and handing it on
 * would make every downstream prompt longer than the last until the chain could
 * not be afforded.
 */
import { parseHandoffRules, type Connection, type DepartmentId, type Task } from "@vo/core";
import { resolveEscalationTarget } from "../escalation/escalation.js";
import type { HandoffAssignment, WorkflowContext, WorkflowEffect } from "./workflow-types.js";

/**
 * How many times work may arrive somewhere before a person is asked about it.
 * Two visits is a round trip, which happens; a third means the office is going
 * round in circles and nobody downstream can tell why.
 */
export const MAX_VISITS_PER_DEPARTMENT = 2;

function assignmentOf(connection: Connection): HandoffAssignment {
  // Refused when the arrow was drawn, so anything unreadable here is an office
  // built before the rule existed: treat it as saying nothing.
  const parsed = parseHandoffRules(connection.rules);
  return parsed.ok ? parsed.value.assign : { kind: "anyone" };
}

function visits(route: readonly DepartmentId[], department: DepartmentId): number {
  return route.filter((seen) => seen === department).length;
}

/**
 * What should happen elsewhere now this task is done.
 *
 * Empty when the department hands off to nobody, which is most of them.
 */
export function handoffEffects(task: Task, context: WorkflowContext): readonly WorkflowEffect[] {
  const connections = context.escalationGraph?.connections ?? [];
  const outgoing = connections.filter(
    (connection) =>
      connection.kind === "handoff" &&
      // An arrow switched off is an arrow the office does not act on, which is
      // what the canvas has been promising and this is the arrow it matters on.
      connection.enabled &&
      connection.fromId === task.departmentId,
  );
  if (outgoing.length === 0) return [];

  // Where it has been, now including here.
  const route: readonly DepartmentId[] = [...task.route, task.departmentId];
  const effects: WorkflowEffect[] = [];

  for (const connection of outgoing) {
    if (visits(route, connection.toId) >= MAX_VISITS_PER_DEPARTMENT) {
      const been = [...route, connection.toId].join(" → ");
      effects.push({
        type: "escalate",
        reason:
          `this work has been through ${connection.toId} ` +
          `${String(visits(route, connection.toId))} times already: ${been}`,
        to:
          context.escalationGraph === undefined
            ? { kind: "owner", hops: 0 }
            : resolveEscalationTarget(context.escalationGraph, {
                employeeId: task.assigneeId,
                departmentId: task.departmentId,
              }),
      });
      continue;
    }

    effects.push({
      type: "create_work",
      because: "handoff",
      connectionId: connection.id,
      toDepartmentId: connection.toId,
      title: task.title,
      brief: `Handed on from ${task.departmentId}, which finished "${task.title}".`,
      artifacts: task.artifacts,
      documents: context.documents ?? [],
      priority: task.priority,
      route,
      assign: assignmentOf(connection),
    });
  }

  return effects;
}

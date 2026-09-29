/**
 * One department noticing what another is doing.
 *
 * A watcher is not in the way. The watched department does not know it is being
 * watched, does not wait for it and is not slowed by it — which is the whole
 * point: a department can be added to a running office without rewiring the
 * ones already there. Legal starts watching Engineering, and Engineering
 * carries on exactly as before.
 *
 * What it notices is read off the task's own status transitions rather than off
 * the office's event log. The statuses are a closed vocabulary the domain
 * already owns; the log is a delivery channel for the canvas that happens to
 * carry strings, and only one of its messages mentions a status at all.
 *
 * The work a watcher raises goes through the same effect a handoff uses, so the
 * two cannot drift apart in how work is created or who it lands on. What it
 * does not do is carry the artifacts across: a watcher was not handed the work,
 * it was told something happened.
 */
import {
  parseWatchRules,
  type Connection,
  type Task,
  type WatchableMoment,
  type HandoffAssignment,
} from "@vo/core";
import type { WorkflowContext, WorkflowEffect } from "./workflow-types.js";

/** What a watcher would call this transition, or null if it is nothing to report. */
export function momentOf(
  before: Task,
  after: Task,
  effects: readonly WorkflowEffect[],
): WatchableMoment | null {
  // Asked first: a task can enter review and open a gate in one move, and the
  // gate is the more interesting half to anybody watching.
  if (effects.some((effect) => effect.type === "request_approval")) return "decision_wanted";
  if (after.status === before.status) return null;
  if (after.status === "in_progress") return "work_started";
  if (after.status === "done") return "work_finished";
  if (after.status === "blocked" || after.status === "escalated") return "work_went_wrong";
  return null;
}

/** What a watching arrow asks for, tolerating rules drawn before it was validated. */
function watchFor(connection: Connection): {
  readonly moments: readonly WatchableMoment[];
  readonly assign: HandoffAssignment;
} {
  const parsed = parseWatchRules(connection.rules);
  return parsed.ok ? parsed.value : { moments: [], assign: { kind: "anyone" } };
}

/**
 * What to call the work this raises.
 *
 * Deliberately never names the watched department: the engine knows only its
 * id, and a task called "dept-engineering went wrong" reads like machine output
 * to the person who has to pick it up. The brief carries the id, where being
 * exact matters more than reading well.
 */
const HEADLINE: Readonly<Record<WatchableMoment, string>> = {
  work_started: "Work started elsewhere",
  work_finished: "Work finished elsewhere",
  work_went_wrong: "Something went wrong elsewhere",
  decision_wanted: "Something is waiting on a person",
};

export function watchEffects(
  before: Task,
  after: Task,
  effects: readonly WorkflowEffect[],
  context: WorkflowContext,
): readonly WorkflowEffect[] {
  const moment = momentOf(before, after, effects);
  if (moment === null) return [];

  const watching = (context.escalationGraph?.connections ?? []).filter(
    (connection) =>
      connection.kind === "watches" && connection.enabled && connection.toId === after.departmentId,
  );
  if (watching.length === 0) return [];

  const raised: WorkflowEffect[] = [];
  for (const connection of watching) {
    const asked = watchFor(connection);
    if (!asked.moments.includes(moment)) continue;

    raised.push({
      type: "create_work",
      because: "watching",
      connectionId: connection.id,
      toDepartmentId: connection.fromId,
      title: `${HEADLINE[moment]}: ${after.title}`,
      brief:
        `Noticed because this department watches ${after.departmentId}, ` +
        `where the task "${after.title}" is now ${after.status}.`,
      // Not handed the work, only told about it.
      artifacts: [],
      documents: [],
      priority: after.priority,
      // Carries where the causing work has been, so the same rule that stops a
      // handoff going in circles stops a pair of watchers doing it too.
      route: [...after.route, after.departmentId],
      assign: asked.assign,
    });
  }
  return raised;
}

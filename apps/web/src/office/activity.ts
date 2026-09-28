/**
 * What everyone is doing, worked out from the office's own tasks.
 *
 * Activity is a view of work, not a second thing to keep in step with it. An
 * employee is working because a task of theirs is under way — not because
 * something remembered to say so — which means the canvas cannot drift from
 * what the office actually holds, and nothing has to be published twice.
 *
 * Somebody with several tasks shows the one that most needs attention: an
 * escalation outranks work in progress, which outranks waiting, because the
 * point of the colour is to draw the eye to what is wrong.
 */
import type { EmployeeId, Task } from "@vo/core";
import type { ActivityState } from "../canvas/EmployeeAvatar.js";

/** Worst first: a figure shows the most urgent thing its person is part of. */
const RANK: Record<ActivityState, number> = { error: 3, working: 2, waiting: 1, idle: 0 };

const WORDS: Record<ActivityState, string> = {
  working: "working",
  waiting: "waiting on somebody else",
  error: "needs attention",
  idle: "nothing on",
};

/** One word, for a chip that has to sit under a figure without wrapping. */
const SHORT: Record<ActivityState, string> = {
  working: "working",
  waiting: "waiting",
  error: "attention",
  idle: "idle",
};

export function describeActivity(state: ActivityState): string {
  return WORDS[state];
}

export function labelActivity(state: ActivityState): string {
  return SHORT[state];
}

function claim(
  activity: Record<string, ActivityState>,
  id: EmployeeId | null,
  state: ActivityState,
): void {
  if (id === null) return;
  const current = activity[id];
  if (current === undefined || RANK[state] > RANK[current]) activity[id] = state;
}

export function activityFromTasks(tasks: readonly Task[]): Record<string, ActivityState> {
  const activity: Record<string, ActivityState> = {};

  for (const task of tasks) {
    switch (task.status) {
      case "in_progress":
        claim(activity, task.assigneeId, "working");
        break;
      case "in_review":
        // The reviewer has something to do; the author is waiting on them.
        for (const reviewerId of task.reviewerIds) claim(activity, reviewerId, "working");
        claim(activity, task.assigneeId, "waiting");
        break;
      case "blocked":
      case "changes_requested":
        claim(activity, task.assigneeId, "waiting");
        break;
      case "escalated":
        claim(activity, task.assigneeId, "error");
        break;
      default:
        // backlog, assigned, approved, done, cancelled, transferred: nothing in
        // flight, so nobody is shown as busy on account of them.
        break;
    }
  }

  return activity;
}

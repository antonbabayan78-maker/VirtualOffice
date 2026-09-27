/**
 * Review mechanics shared by every policy that has a review step. Policies
 * differ only in who reviews; the round counting, reviewer authority, approval
 * path and escalation cap are the same, so they live here once.
 */
import type { EmployeeId, Result, Task } from "@vo/core";
import {
  applyTransition,
  workflowError,
  type PolicyEvent,
  type WorkflowContext,
  type WorkflowOutcome,
} from "./workflow-types.js";

/** How many change-request rounds this task has already been through. */
export function reviewRounds(task: Task): number {
  return task.history.filter((event) => event.to === "changes_requested").length;
}

export interface ReviewerChoice {
  readonly reviewerIds: readonly EmployeeId[];
  readonly audience: "supervisor" | "owner" | "reviewer";
}

/** The supervisor as reviewer, or the office owner when the department has none. */
export function supervisorChoice(task: Task, context: WorkflowContext): Result<ReviewerChoice> {
  const supervisorId = context.supervisorId ?? null;
  if (supervisorId === null) return { ok: true, value: { reviewerIds: [], audience: "owner" } };
  if (supervisorId === task.assigneeId) {
    return workflowError(
      "supervisorId",
      "the supervisor may not review their own work; configure a different reviewer",
    );
  }
  return { ok: true, value: { reviewerIds: [supervisorId], audience: "supervisor" } };
}

export function submitForReview(
  task: Task,
  event: Extract<PolicyEvent, { type: "submit" }>,
  context: WorkflowContext,
  choice: ReviewerChoice,
): Result<WorkflowOutcome> {
  const staged: Task = {
    ...task,
    reviewerIds: [...choice.reviewerIds],
    // A new round is judged on its own merits, never on earlier approvals.
    approvals: [],
    artifacts: [...task.artifacts, ...(event.artifacts ?? [])],
  };
  return applyTransition(staged, "in_review", event, context, [
    {
      type: "notify",
      audience: choice.audience,
      message: `review requested for task "${task.title}"`,
    },
  ]);
}

export function assertReviewer(
  task: Task,
  event: PolicyEvent,
  action: string,
): Result<WorkflowOutcome> | null {
  // No named reviewers means the office owner reviews, and any actor may act for them.
  if (task.reviewerIds.length === 0) return null;
  if (!task.reviewerIds.includes(event.actorId)) {
    return workflowError(
      "actorId",
      `"${event.actorId}" is not a reviewer of this task and may not ${action} it`,
    );
  }
  return null;
}

export function approveReview(
  task: Task,
  event: Extract<PolicyEvent, { type: "approve" }>,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const denied = assertReviewer(task, event, "approve");
  if (denied) return denied;
  const approved = applyTransition(task, "approved", event, context);
  if (!approved.ok) return approved;
  return applyTransition(approved.value.task, "done", event, context, [
    { type: "notify", audience: "assignee", message: `task "${task.title}" was approved` },
  ]);
}

export function requestChangesOrEscalate(
  task: Task,
  event: Extract<PolicyEvent, { type: "request_changes" }>,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const reason = event.reason.trim();
  if (reason.length === 0) {
    return workflowError("reason", "a change request needs a reason the assignee can act on");
  }
  const denied = assertReviewer(task, event, "review");
  if (denied) return denied;

  if (!("maxIterations" in context.policy)) {
    return workflowError(
      "policy",
      `a review policy needs maxIterations; got "${context.policy.kind}"`,
    );
  }
  const maxIterations = context.policy.maxIterations;

  if (reviewRounds(task) + 1 > maxIterations) {
    const escalation = `escalated after ${String(maxIterations)} review rounds without approval`;
    return applyTransition(
      task,
      "escalated",
      event,
      context,
      [
        { type: "escalate", reason: escalation },
        {
          type: "notify",
          audience: "owner",
          message: `task "${task.title}" escalated: ${escalation}`,
        },
      ],
      escalation,
    );
  }

  const staged: Task = { ...task, approvals: [] };
  const changed = applyTransition(staged, "changes_requested", event, context, [], reason);
  if (!changed.ok) return changed;
  return applyTransition(changed.value.task, "in_progress", event, context, [
    {
      type: "notify",
      audience: "assignee",
      message: `changes requested on "${task.title}": ${reason}`,
    },
  ]);
}

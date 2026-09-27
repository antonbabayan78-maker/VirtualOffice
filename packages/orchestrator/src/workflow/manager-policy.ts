/**
 * Manager review policy (plan §3, scenario 2).
 *
 * Submitted work goes to the department's supervisor for review. Approval
 * completes the task; a change request sends it back to the assignee with the
 * reason. Review rounds are counted from the task's own history rather than
 * stored separately, so the count survives persistence and a resumed run for
 * free. Once the configured cap is used up, the next change request escalates
 * instead of looping again.
 */
import type { Result, Task } from "@vo/core";
import {
  applyTransition,
  workflowError,
  type PolicyEvent,
  type PolicyHandler,
  type WorkflowContext,
  type WorkflowOutcome,
} from "./workflow-types.js";

/** How many change-request rounds this task has already been through. */
export function reviewRounds(task: Task): number {
  return task.history.filter((event) => event.to === "changes_requested").length;
}

function assertReviewer(
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

function submit(
  task: Task,
  event: Extract<PolicyEvent, { type: "submit" }>,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const supervisorId = context.supervisorId ?? null;
  if (supervisorId !== null && supervisorId === task.assigneeId) {
    return workflowError(
      "supervisorId",
      "the supervisor may not review their own work; configure a different reviewer",
    );
  }
  const staged: Task = {
    ...task,
    reviewerIds: supervisorId === null ? [] : [supervisorId],
    artifacts: [...task.artifacts, ...(event.artifacts ?? [])],
  };
  return applyTransition(staged, "in_review", event, context, [
    {
      type: "notify",
      audience: supervisorId === null ? "owner" : "supervisor",
      message: `review requested for task "${task.title}"`,
    },
  ]);
}

function approve(
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

function requestChanges(
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
      `the manager policy needs maxIterations; got "${context.policy.kind}"`,
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

  const changed = applyTransition(task, "changes_requested", event, context, [], reason);
  if (!changed.ok) return changed;
  return applyTransition(changed.value.task, "in_progress", event, context, [
    {
      type: "notify",
      audience: "assignee",
      message: `changes requested on "${task.title}": ${reason}`,
    },
  ]);
}

export const MANAGER_POLICY_HANDLER: PolicyHandler = {
  kind: "manager",
  handle(task, event, context) {
    switch (event.type) {
      case "submit":
        return submit(task, event, context);
      case "approve":
        return approve(task, event, context);
      case "request_changes":
        return requestChanges(task, event, context);
    }
  },
};

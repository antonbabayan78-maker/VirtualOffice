/**
 * Quorum review policy (plan §3, scenario 4).
 *
 * A committee of peers reviews the work and `required` of them must approve
 * before it completes. Approvals arrive one at a time and are recorded on the
 * task, so a half-gathered quorum survives a restart: the task simply stays in
 * review until the count is met. A single change request outweighs any number
 * of approvals and sends the work straight back, and the next round starts with
 * a clean slate. A committee that cannot be staffed is refused at submit time
 * rather than quietly completing on fewer approvals than were asked for.
 */
import type { Result, Task } from "@vo/core";
import { rankPeers } from "./peer-policy.js";
import {
  approveReview,
  assertReviewer,
  requestChangesOrEscalate,
  submitForReview,
} from "./review-common.js";
import {
  workflowError,
  type PolicyEvent,
  type PolicyHandler,
  type WorkflowContext,
  type WorkflowOutcome,
} from "./workflow-types.js";

function requiredApprovals(context: WorkflowContext): Result<number> {
  if (!("required" in context.policy)) {
    return workflowError<number>(
      "policy",
      `a quorum policy needs a required approval count; got "${context.policy.kind}"`,
    );
  }
  return { ok: true, value: context.policy.required };
}

function formCommittee(
  task: Task,
  event: Extract<PolicyEvent, { type: "submit" }>,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const required = requiredApprovals(context);
  if (!required.ok) return required;

  const eligible = rankPeers(context.peers ?? [], {
    assigneeId: task.assigneeId,
    reviewSkills: context.reviewSkills ?? [],
  });
  if (eligible.length < required.value) {
    return workflowError(
      "policy.required",
      `a quorum of ${String(required.value)} reviewers is configured but only ` +
        `${String(eligible.length)} eligible reviewers are available`,
    );
  }

  return submitForReview(task, event, context, {
    reviewerIds: eligible.slice(0, required.value).map((peer) => peer.id),
    audience: "reviewer",
  });
}

function gatherApproval(
  task: Task,
  event: Extract<PolicyEvent, { type: "approve" }>,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const required = requiredApprovals(context);
  if (!required.ok) return required;
  if (task.status !== "in_review") {
    return workflowError(
      "status",
      `approvals are only gathered while a task is in review; this one is "${task.status}"`,
    );
  }
  const denied = assertReviewer(task, event, "approve");
  if (denied) return denied;

  // A reviewer who approves twice has still only approved once.
  const approvals = task.approvals.includes(event.actorId)
    ? task.approvals
    : [...task.approvals, event.actorId];
  const staged: Task = { ...task, approvals };

  if (approvals.length >= required.value) return approveReview(staged, event, context);
  return {
    ok: true,
    value: {
      task: staged,
      effects: [
        {
          type: "notify",
          audience: "reviewer",
          message:
            `task "${task.title}" has ${String(approvals.length)} of ` +
            `${String(required.value)} approvals`,
        },
      ],
    },
  };
}

export const QUORUM_POLICY_HANDLER: PolicyHandler = {
  kind: "quorum",
  handle(task, event, context) {
    switch (event.type) {
      case "submit":
        return formCommittee(task, event, context);
      case "approve":
        return gatherApproval(task, event, context);
      case "request_changes":
        return requestChangesOrEscalate(task, event, context);
    }
  },
};

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
  rejectCheckReport,
  requestChangesOrEscalate,
  submitForReview,
  tallyApproval,
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

  const tally = tallyApproval(task, event, required.value);
  if (!tally.ok) return tally;
  if (tally.value.reached) return approveReview(tally.value.task, event, context);

  return {
    ok: true,
    value: {
      task: tally.value.task,
      effects: [
        {
          type: "notify",
          audience: "reviewer",
          message:
            `task "${task.title}" has ${String(tally.value.gathered)} of ` +
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
        return requestChangesOrEscalate(task, event, context, event.reason);
      case "check_reported":
        return rejectCheckReport("quorum");
    }
  },
};

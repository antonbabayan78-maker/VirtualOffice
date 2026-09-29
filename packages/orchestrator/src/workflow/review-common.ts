/**
 * Review mechanics shared by every policy that has a review step. Policies
 * differ only in who reviews; the round counting, reviewer authority, approval
 * path and escalation cap are the same, so they live here once.
 */
import type { EmployeeId, Result, Task } from "@vo/core";
import { acceptanceCriteriaFor, unmetCriteria } from "./acceptance.js";
import { checkerFor, signedOffBy } from "./checker.js";
import { escalateTask } from "../escalation/escalation.js";
import {
  applyTransition,
  workflowError,
  type PolicyEvent,
  type WorkflowContext,
  type WorkflowEvent,
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

export function assertReviewer<T = WorkflowOutcome>(
  task: Task,
  event: WorkflowEvent,
  action: string,
): Result<T> | null {
  // No named reviewers means the office owner reviews, and any actor may act for them.
  if (task.reviewerIds.length === 0) return null;
  const actorId = event.actorId;
  if (actorId === undefined || !task.reviewerIds.includes(actorId)) {
    return workflowError<T>(
      "actorId",
      `"${actorId ?? "nobody"}" is not a reviewer of this task and may not ${action} it`,
    );
  }
  return null;
}

/** A policy refuses an event it cannot act on rather than ignoring it. */
export function rejectPolicyEvent<T = WorkflowOutcome>(
  kind: string,
  event: PolicyEvent,
): Result<T> {
  return workflowError<T>(
    "event",
    `the "${kind}" review policy does not handle a "${event.type}" event`,
  );
}

/**
 * Approvals gathered so far against the number a review needs. Policies that
 * need more than one sign-off (quorum, and each stage of a pipeline) share this
 * counting so a reviewer who approves twice is still counted once.
 */
export type ApprovalTally =
  | { readonly reached: false; readonly task: Task; readonly gathered: number }
  | { readonly reached: true; readonly task: Task };

export function tallyApproval(
  task: Task,
  event: Extract<PolicyEvent, { type: "approve" }>,
  required: number,
): Result<ApprovalTally> {
  if (task.status !== "in_review") {
    return workflowError<ApprovalTally>(
      "status",
      `approvals are only gathered while a task is in review; this one is "${task.status}"`,
    );
  }
  const denied = assertReviewer<ApprovalTally>(task, event, "approve");
  if (denied) return denied;

  const approvals = task.approvals.includes(event.actorId)
    ? task.approvals
    : [...task.approvals, event.actorId];
  const staged: Task = { ...task, approvals };
  if (approvals.length >= required) return { ok: true, value: { reached: true, task: staged } };
  return { ok: true, value: { reached: false, task: staged, gathered: approvals.length } };
}

/**
 * What this work still owes, given what the approval claimed.
 *
 * Empty for an office that has defined no criteria, which is why none of this
 * changes how such an office behaves.
 */
export function outstandingFor(
  task: Task,
  event: WorkflowEvent,
  context: WorkflowContext,
): readonly string[] {
  const criteria = acceptanceCriteriaFor(task.acceptanceCriteria, context.acceptanceCriteria ?? []);
  return unmetCriteria(criteria, claimedIn(event));
}

/** What this event says was met. A check answers through its report. */
function claimedIn(event: WorkflowEvent): readonly string[] {
  switch (event.type) {
    case "check_reported":
      return event.report.met ?? [];
    case "submit":
    case "approve":
      return event.met ?? [];
    default:
      return [];
  }
}

export function approveReview(
  task: Task,
  event: WorkflowEvent,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const denied = assertReviewer(task, event, "approve");
  if (denied) return denied;

  // An approval that leaves something on the list is not an approval. The work
  // goes back naming what is outstanding, which is also what the next round
  // needs to be told.
  const outstanding = outstandingFor(task, event, context);
  if (outstanding.length > 0) {
    return requestChangesOrEscalate(
      task,
      event,
      context,
      `not done yet: ${outstanding.join("; ")}`,
    );
  }

  // Whoever just approved may themselves have been a department checking this
  // one's work; their signature goes on before anybody asks who is left.
  const signed: Task = { ...task, checkedBy: signedOffBy(task, event.actorId ?? null, context) };

  const pending = checkerFor(signed, context);
  if (pending !== null) {
    // Its own department has approved; another still has to check. Recorded as
    // two steps rather than one so the history says both — approved here, then
    // waiting on somebody outside — which is what an audit of this work needs.
    const approvedHere = applyTransition(signed, "approved", event, context);
    if (!approvedHere.ok) return approvedHere;
    return applyTransition(
      { ...approvedHere.value.task, reviewerIds: [pending.reviewerId], approvals: [] },
      "in_review",
      event,
      context,
      [
        {
          type: "notify",
          audience: "reviewer",
          message: `task "${task.title}" is waiting to be checked by ${pending.departmentId}`,
        },
      ],
      `waiting to be checked by ${pending.departmentId}`,
    );
  }

  const approved = applyTransition(signed, "approved", event, context);
  if (!approved.ok) return approved;
  return applyTransition(approved.value.task, "done", event, context, [
    { type: "notify", audience: "assignee", message: `task "${task.title}" was approved` },
  ]);
}

export function requestChangesOrEscalate(
  task: Task,
  event: WorkflowEvent,
  context: WorkflowContext,
  rawReason: string,
  /**
   * How many rounds are allowed when the department's policy declares none. A
   * department that reviews nothing of its own still cannot be sent round
   * forever by a department that checks it.
   */
  cap?: number,
): Result<WorkflowOutcome> {
  const reason = rawReason.trim();
  if (reason.length === 0) {
    return workflowError("reason", "a change request needs a reason the assignee can act on");
  }
  const denied = assertReviewer(task, event, "review");
  if (denied) return denied;

  const declared = "maxIterations" in context.policy ? context.policy.maxIterations : cap;
  if (declared === undefined) {
    return workflowError(
      "policy",
      `a review policy needs maxIterations; got "${context.policy.kind}"`,
    );
  }
  const maxIterations = declared;

  if (reviewRounds(task) + 1 > maxIterations) {
    return escalateTask(
      task,
      { kind: "review_rounds", rounds: reviewRounds(task) + 1, limit: maxIterations },
      event,
      context,
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

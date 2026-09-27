/**
 * Human-in-the-loop gate policy (plan §3, scenario 5).
 *
 * Some work should not ship on an agent's word alone: money spent, a message
 * sent outside the office, a deploy, a delete. A department gates the categories
 * it cares about, a task records which ones its work actually involved, and only
 * the overlap waits for a person. Everything else goes through untouched, so the
 * gate costs nothing on ordinary work.
 *
 * A pending gate is returned as a `request_approval` effect — the approvals
 * inbox is fed from that — plus a notification to the owner. The decision comes
 * back as a `gate_decided` event carrying who decided; no agent can approve or
 * reject in the owner's place, which is the whole point of the gate. A rejection
 * returns the work with the owner's reason and no escalation cap, because the
 * owner is already the top of the chain.
 *
 * What counts as a gated action — how much spend is spend, which connectors are
 * external — is decided where the action happens, not here. This policy acts on
 * what the task records. A gate that must stop a tool call *before* it runs is a
 * separate concern from reviewing finished work, and belongs to the run loop.
 */
import type { GatedAction, Result, Task } from "@vo/core";
import { rejectPolicyEvent } from "./review-common.js";
import {
  applyTransition,
  workflowError,
  type PolicyEvent,
  type PolicyHandler,
  type WorkflowContext,
  type WorkflowOutcome,
} from "./workflow-types.js";

function gatedCategories(context: WorkflowContext): Result<readonly GatedAction[]> {
  if (context.policy.kind !== "gate") {
    return workflowError<readonly GatedAction[]>(
      "policy",
      `a human gate needs the categories it gates; got "${context.policy.kind}"`,
    );
  }
  return { ok: true, value: context.policy.gatedActions };
}

/** What this task does that the department gates, in the order the gate declares. */
function needsApproval(task: Task, gates: readonly GatedAction[]): readonly GatedAction[] {
  return gates.filter((gate) => task.gatedActions.includes(gate));
}

function submitThroughGate(
  task: Task,
  event: Extract<PolicyEvent, { type: "submit" }>,
  context: WorkflowContext,
  gates: readonly GatedAction[],
): Result<WorkflowOutcome> {
  const staged: Task = {
    ...task,
    reviewerIds: [],
    approvals: [],
    artifacts: [...task.artifacts, ...(event.artifacts ?? [])],
  };

  const pending = needsApproval(task, gates);
  if (pending.length === 0) return applyTransition(staged, "done", event, context);

  const listed = pending.join(", ");
  return applyTransition(staged, "in_review", event, context, [
    {
      type: "request_approval",
      gates: pending,
      summary: `task "${task.title}" involves ${listed} and needs an owner decision`,
    },
    {
      type: "notify",
      audience: "owner",
      message: `task "${task.title}" is waiting for your approval: ${listed}`,
    },
  ]);
}

function applyDecision(
  task: Task,
  event: Extract<PolicyEvent, { type: "gate_decided" }>,
  context: WorkflowContext,
): Result<WorkflowOutcome> {
  const decidedBy = event.decidedBy.trim();
  if (decidedBy.length === 0) {
    return workflowError("decidedBy", "a gate decision has to say who made it");
  }
  if (task.status !== "in_review") {
    return workflowError(
      "status",
      `only work that is in review is waiting for a gate decision; this task is "${task.status}"`,
    );
  }

  if (event.decision === "approved") {
    const approved = applyTransition(
      task,
      "approved",
      event,
      context,
      [],
      `gate approved by ${decidedBy}`,
    );
    if (!approved.ok) return approved;
    return applyTransition(approved.value.task, "done", event, context, [
      {
        type: "notify",
        audience: "assignee",
        message: `task "${task.title}" was approved by ${decidedBy}`,
      },
    ]);
  }

  const reason = (event.reason ?? "").trim();
  if (reason.length === 0) {
    return workflowError("reason", "a declined gate needs a reason the assignee can act on");
  }
  const declined = applyTransition(task, "changes_requested", event, context, [], reason);
  if (!declined.ok) return declined;
  return applyTransition(declined.value.task, "in_progress", event, context, [
    {
      type: "notify",
      audience: "assignee",
      message: `${decidedBy} declined "${task.title}": ${reason}`,
    },
  ]);
}

export const GATE_POLICY_HANDLER: PolicyHandler = {
  kind: "gate",
  handle(task, event, context) {
    const gates = gatedCategories(context);
    if (!gates.ok) return gates;

    switch (event.type) {
      case "submit":
        return submitThroughGate(task, event, context, gates.value);
      case "gate_decided":
        return applyDecision(task, event, context);
      case "approve":
      case "request_changes":
        return workflowError(
          "event",
          "a gated task waits for a human owner decision, not an agent review",
        );
      case "check_reported":
        return rejectPolicyEvent("gate", event);
    }
  },
};

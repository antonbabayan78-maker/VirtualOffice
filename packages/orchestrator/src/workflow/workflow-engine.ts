/**
 * Workflow engine core (plan §3).
 *
 * The engine turns a workflow event into a task transition plus a list of
 * effects. It performs no IO: transitions go through the core task state
 * machine, and anything with a side effect (notifications, escalations) comes
 * back as data for the caller to carry out. Events that do not depend on a
 * review policy (start, block, unblock, cancel) are handled here; submit,
 * approve and request_changes are delegated to the handler registered for the
 * department's review policy, so each policy can be added on its own.
 */
import type { GatedAction, Result, Task } from "@vo/core";
import { AUTOMATED_POLICY_HANDLER } from "./automated-policy.js";
import { handoffEffects } from "./handoff.js";
import { watchEffects } from "./watch.js";
import { checkerFor } from "./checker.js";
import { approveReview, outstandingFor, requestChangesOrEscalate } from "./review-common.js";
import { GATE_POLICY_HANDLER } from "./gate-policy.js";
import { MANAGER_POLICY_HANDLER } from "./manager-policy.js";
import { PEER_POLICY_HANDLER } from "./peer-policy.js";
import { PIPELINE_POLICY_HANDLER } from "./pipeline-policy.js";
import { QUORUM_POLICY_HANDLER } from "./quorum-policy.js";
import {
  applyTransition,
  workflowError,
  type PolicyHandler,
  type WorkflowContext,
  type WorkflowEffect,
  type WorkflowEvent,
  type WorkflowOutcome,
} from "./workflow-types.js";

export { applyTransition, workflowError } from "./workflow-types.js";
export type {
  HeldCall,
  PeerCandidate,
  PolicyEvent,
  PolicyHandler,
  WorkflowContext,
  WorkflowEffect,
  WorkflowEvent,
  WorkflowOutcome,
} from "./workflow-types.js";

/**
 * How many times a department that reviews nothing of its own may be sent back
 * by a department that checks it. It declares no cap because it has no policy,
 * and without one an obstinate checker could keep work moving forever.
 */
const CHECK_ROUNDS = 3;

export const DIRECT_POLICY_HANDLER: PolicyHandler = {
  kind: "direct",
  handle(task, event, context) {
    // This policy reviews nothing of its own, but another department may check
    // its work — and then somebody has to be able to answer. Without this a
    // department with a checker is a dead end: put into review and never taken
    // out of it.
    const asked = task.status === "in_review" && task.reviewerIds.length > 0;
    if (asked && event.type === "approve") return approveReview(task, event, context);
    if (asked && event.type === "request_changes") {
      return requestChangesOrEscalate(task, event, context, event.reason, CHECK_ROUNDS);
    }
    if (event.type !== "submit") {
      return workflowError(
        "event.type",
        `the direct policy has no review step, so "${event.type}" does not apply`,
      );
    }
    const withArtifacts: Task =
      event.artifacts === undefined || event.artifacts.length === 0
        ? task
        : { ...task, artifacts: [...task.artifacts, ...event.artifacts] };

    // Nobody reviews here, so the person submitting answers the list. Without
    // this, the way round a definition of done is a department with nobody to
    // check it — the easiest way round there could be.
    //
    // Refused rather than moved: the work simply is not finished, and there is
    // no state between in progress and done for it to sit in. The refusal says
    // what is outstanding, which is what whoever is doing the work needs.
    const outstanding = outstandingFor(withArtifacts, event, context);
    if (outstanding.length > 0) {
      return workflowError("met", `not done yet: ${outstanding.join("; ")}`);
    }

    // Nobody reviews here, but another department may still check this one's
    // work. Straight into review, since there was no approval step to record.
    const pending = checkerFor(withArtifacts, context);
    if (pending !== null) {
      return applyTransition(
        { ...withArtifacts, reviewerIds: [pending.reviewerId], approvals: [] },
        "in_review",
        event,
        context,
        [],
        `waiting to be checked by ${pending.departmentId}`,
      );
    }
    return applyTransition(withArtifacts, "done", event, context);
  },
};

export class WorkflowEngine {
  private readonly handlers = new Map<string, PolicyHandler>();

  constructor(handlers: readonly PolicyHandler[]) {
    for (const handler of handlers) {
      if (this.handlers.has(handler.kind))
        throw new Error(`duplicate workflow policy handler for "${handler.kind}"`);
      this.handlers.set(handler.kind, handler);
    }
  }

  policyKinds(): string[] {
    return [...this.handlers.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  handle(task: Task, event: WorkflowEvent, context: WorkflowContext): Result<WorkflowOutcome> {
    const outcome = this.decide(task, event, context);
    if (!outcome.ok) return outcome;

    // What happens here makes work happen elsewhere: a department finishing
    // hands work on, and any department watching this one may have its own work
    // to raise. Appended once, in the one place every event and every policy
    // returns through, rather than at each transition that could cause it —
    // applyTransition replaces effects rather than accumulating them, so every
    // call site would be another chance to get it wrong and one more waiting
    // for the next policy added.
    const raised = [
      // Only a task that has just reached done hands anything on. Both halves
      // of the test are needed: one for work that was already finished, one for
      // work that did not get there.
      ...(task.status !== "done" && outcome.value.task.status === "done"
        ? handoffEffects(outcome.value.task, context)
        : []),
      ...watchEffects(task, outcome.value.task, outcome.value.effects, context),
    ];
    if (raised.length === 0) return outcome;
    return {
      ok: true,
      value: { task: outcome.value.task, effects: [...outcome.value.effects, ...raised] },
    };
  }

  private decide(
    task: Task,
    event: WorkflowEvent,
    context: WorkflowContext,
  ): Result<WorkflowOutcome> {
    switch (event.type) {
      case "start":
        return applyTransition(task, "in_progress", event, context);
      case "block": {
        const effects: WorkflowEffect[] = [
          {
            type: "notify",
            audience: "supervisor",
            message: `task "${task.title}" is blocked: ${event.reason}`,
          },
        ];
        return applyTransition(task, "blocked", event, context, effects, event.reason);
      }
      case "unblock": {
        if (task.assigneeId === null) {
          return workflowError(
            "assigneeId",
            "a blocked task needs an assignee before it can resume; transfer or reassign it first",
          );
        }
        return applyTransition(task, "in_progress", event, context);
      }
      case "cancel":
        return applyTransition(task, "cancelled", event, context, [], event.reason);
      case "await_decision": {
        if (event.items.length === 0) {
          return workflowError("items", "work cannot wait for a decision about nothing");
        }
        // The same inbox the review gate feeds, so there is one place a person
        // looks, and the owner is told because nobody else may answer this.
        const gates: GatedAction[] = [];
        for (const item of event.items) {
          for (const gate of item.gates) if (!gates.includes(gate)) gates.push(gate);
        }
        return applyTransition(
          task,
          "blocked",
          event,
          context,
          [
            { type: "request_approval", gates, summary: event.summary },
            {
              type: "notify",
              audience: "owner",
              message: `task "${task.title}" is waiting for your decision: ${event.summary}`,
            },
          ],
          event.summary,
        );
      }
      case "call_decided": {
        const decidedBy = event.decidedBy.trim();
        if (decidedBy.length === 0) {
          return workflowError("decidedBy", "a decision has to say who made it");
        }
        if (event.key.trim().length === 0) {
          return workflowError("key", "a decision has to say which call it is about");
        }
        if (task.status !== "blocked") {
          return workflowError(
            "status",
            `only work that is waiting has a held call to decide; this task is "${task.status}"`,
          );
        }
        const reason = (event.reason ?? "").trim();
        const said =
          event.decision === "approved"
            ? `${decidedBy} approved ${event.key}`
            : `${decidedBy} declined ${event.key}${reason.length === 0 ? "" : `: ${reason}`}`;
        // Back to work either way. A declined call is answered, not cancelled:
        // the run is told and decides what to do about it.
        return applyTransition(
          task,
          "in_progress",
          event,
          context,
          [{ type: "notify", audience: "assignee", message: `${said} on "${task.title}"` }],
          said,
        );
      }
      case "submit":
      case "approve":
      case "request_changes":
      case "check_reported":
      case "gate_decided": {
        const handler = this.handlers.get(context.policy.kind);
        if (!handler) {
          return workflowError(
            "policy.kind",
            `no handler for review policy "${context.policy.kind}"; supported: ${this.policyKinds().join(", ")}`,
          );
        }
        return handler.handle(task, event, context);
      }
    }
  }
}

/** An engine with every policy handler that ships today. */
export function defaultWorkflowEngine(): WorkflowEngine {
  return new WorkflowEngine([
    DIRECT_POLICY_HANDLER,
    MANAGER_POLICY_HANDLER,
    PEER_POLICY_HANDLER,
    QUORUM_POLICY_HANDLER,
    PIPELINE_POLICY_HANDLER,
    AUTOMATED_POLICY_HANDLER,
    GATE_POLICY_HANDLER,
  ]);
}

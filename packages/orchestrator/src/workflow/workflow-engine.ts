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
import type { Result, Task } from "@vo/core";
import { AUTOMATED_POLICY_HANDLER } from "./automated-policy.js";
import { handoffEffects } from "./handoff.js";
import { outstandingFor } from "./review-common.js";
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
  PeerCandidate,
  PolicyEvent,
  PolicyHandler,
  WorkflowContext,
  WorkflowEffect,
  WorkflowEvent,
  WorkflowOutcome,
} from "./workflow-types.js";

export const DIRECT_POLICY_HANDLER: PolicyHandler = {
  kind: "direct",
  handle(task, event, context) {
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

    // Finishing here is where work elsewhere begins. Appended once, in the one
    // place every event and every policy returns through, rather than at each
    // of the five transitions that can reach done — applyTransition replaces
    // effects rather than accumulating them, so five call sites would be five
    // chances to get it wrong and a sixth waiting for the next policy added.
    if (task.status === "done" || outcome.value.task.status !== "done") return outcome;
    const handoffs = handoffEffects(outcome.value.task, context);
    if (handoffs.length === 0) return outcome;
    return {
      ok: true,
      value: { task: outcome.value.task, effects: [...outcome.value.effects, ...handoffs] },
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

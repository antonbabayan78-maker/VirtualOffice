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
import { err, transitionTask, type EmployeeId, type Result, type Task } from "@vo/core";

export interface WorkflowContext {
  readonly policy: { readonly kind: string };
  readonly now: Date;
  /** Who reviews this department's work; null when the office owner does. */
  readonly supervisorId?: EmployeeId | null;
}

export type WorkflowEvent =
  | { readonly type: "start"; readonly actorId?: EmployeeId }
  | {
      readonly type: "submit";
      readonly actorId: EmployeeId;
      readonly artifacts?: readonly string[];
    }
  | { readonly type: "approve"; readonly actorId: EmployeeId; readonly note?: string }
  | { readonly type: "request_changes"; readonly actorId: EmployeeId; readonly reason: string }
  | { readonly type: "block"; readonly reason: string; readonly actorId?: EmployeeId }
  | { readonly type: "unblock"; readonly actorId?: EmployeeId }
  | { readonly type: "cancel"; readonly reason: string; readonly actorId?: EmployeeId };

export interface WorkflowEffect {
  readonly type: "notify";
  readonly audience: "supervisor" | "owner" | "assignee";
  readonly message: string;
}

export interface WorkflowOutcome {
  readonly task: Task;
  readonly effects: readonly WorkflowEffect[];
}

export interface PolicyHandler {
  readonly kind: string;
  handle(task: Task, event: WorkflowEvent, context: WorkflowContext): Result<WorkflowOutcome>;
}

function fail(path: string, message: string): Result<WorkflowOutcome> {
  return err([{ path, message }]);
}

/** Applies one transition through the core state machine and returns it with its effects. */
export function applyTransition(
  task: Task,
  to: Parameters<typeof transitionTask>[1],
  event: WorkflowEvent,
  context: WorkflowContext,
  effects: readonly WorkflowEffect[] = [],
  reason?: string,
): Result<WorkflowOutcome> {
  const moved = transitionTask(task, to, {
    at: context.now,
    actorId: event.actorId ?? null,
    ...(reason === undefined ? {} : { reason }),
  });
  if (!moved.ok) return err(moved.error);
  return { ok: true, value: { task: moved.value, effects } };
}

export const DIRECT_POLICY_HANDLER: PolicyHandler = {
  kind: "direct",
  handle(task, event, context) {
    if (event.type !== "submit") {
      return fail(
        "event.type",
        `the direct policy has no review step, so "${event.type}" does not apply`,
      );
    }
    const withArtifacts: Task =
      event.artifacts === undefined || event.artifacts.length === 0
        ? task
        : { ...task, artifacts: [...task.artifacts, ...event.artifacts] };
    return applyTransition(withArtifacts, "done", event, context);
  },
};

const POLICY_EVENTS = new Set<WorkflowEvent["type"]>(["submit", "approve", "request_changes"]);

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
          return fail(
            "assigneeId",
            "a blocked task needs an assignee before it can resume; transfer or reassign it first",
          );
        }
        return applyTransition(task, "in_progress", event, context);
      }
      case "cancel":
        return applyTransition(task, "cancelled", event, context, [], event.reason);
      default:
        break;
    }

    if (!POLICY_EVENTS.has(event.type)) {
      return fail("event.type", `unsupported workflow event "${event.type}"`);
    }
    const handler = this.handlers.get(context.policy.kind);
    if (!handler) {
      return fail(
        "policy.kind",
        `no handler for review policy "${context.policy.kind}"; supported: ${this.policyKinds().join(", ")}`,
      );
    }
    return handler.handle(task, event, context);
  }
}

/** An engine with every policy handler that ships today. */
export function defaultWorkflowEngine(): WorkflowEngine {
  return new WorkflowEngine([DIRECT_POLICY_HANDLER]);
}

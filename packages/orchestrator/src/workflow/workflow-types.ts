/**
 * Shared workflow vocabulary. Policy handlers import only this module, so adding
 * a policy never creates an import cycle with the engine that registers it.
 */
import {
  err,
  transitionTask,
  type EmployeeId,
  type ReviewPolicy,
  type Result,
  type Task,
  type TaskStatus,
} from "@vo/core";

export interface WorkflowContext {
  readonly policy: ReviewPolicy;
  readonly now: Date;
  /** Who reviews this department's work; null or absent when the office owner does. */
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

/** The events a review policy decides; everything else is policy-independent. */
export type PolicyEvent = Extract<
  WorkflowEvent,
  { type: "submit" | "approve" | "request_changes" }
>;

export type WorkflowEffect =
  | {
      readonly type: "notify";
      readonly audience: "supervisor" | "owner" | "assignee";
      readonly message: string;
    }
  | { readonly type: "escalate"; readonly reason: string };

export interface WorkflowOutcome {
  readonly task: Task;
  readonly effects: readonly WorkflowEffect[];
}

export interface PolicyHandler {
  readonly kind: string;
  handle(task: Task, event: PolicyEvent, context: WorkflowContext): Result<WorkflowOutcome>;
}

export function workflowError(path: string, message: string): Result<WorkflowOutcome> {
  return err([{ path, message }]);
}

/** Applies one transition through the core state machine, carrying the effects onto the outcome. */
export function applyTransition(
  task: Task,
  to: TaskStatus,
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

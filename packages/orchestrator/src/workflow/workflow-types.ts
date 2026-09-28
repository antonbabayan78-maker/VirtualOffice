/**
 * Shared workflow vocabulary. Policy handlers import only this module, so adding
 * a policy never creates an import cycle with the engine that registers it.
 */
import {
  err,
  transitionTask,
  type ConnectionId,
  type DepartmentId,
  type EmployeeId,
  type EmployeeStatus,
  type GatedAction,
  type HandoffAssignment,
  type ReviewPolicy,
  type Result,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@vo/core";
import type { CheckReport } from "./check-runner.js";

export type { HandoffAssignment } from "@vo/core";
import type { EscalationGraph, EscalationTarget } from "../escalation/escalation.js";

/** A colleague the peer policy may pick as reviewer, resolved by the caller from storage. */
export interface PeerCandidate {
  readonly id: EmployeeId;
  readonly status: EmployeeStatus;
  readonly skillIds: readonly string[];
  /** Open tasks currently assigned, used to spread review load. */
  readonly openTasks: number;
}

export interface WorkflowContext {
  readonly policy: ReviewPolicy;
  readonly now: Date;
  /** Who reviews this department's work; null or absent when the office owner does. */
  readonly supervisorId?: EmployeeId | null;
  /** Colleagues eligible for peer review. */
  readonly peers?: readonly PeerCandidate[];
  /** Skills the work needs, used to rank peer reviewers. */
  readonly reviewSkills?: readonly string[];
  /** Who work escalates to. Absent means everything escalates to the owner. */
  readonly escalationGraph?: EscalationGraph;
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
  | { readonly type: "cancel"; readonly reason: string; readonly actorId?: EmployeeId }
  | {
      /** The result of an automated check, dispatched by whoever ran it. */
      readonly type: "check_reported";
      readonly report: CheckReport;
      readonly actorId?: EmployeeId;
    }
  | {
      /**
       * A person's decision on a gated task, dispatched by the application on
       * behalf of the authenticated human. No employee acted, hence no actorId;
       * `decidedBy` records who it was.
       */
      readonly type: "gate_decided";
      readonly decision: "approved" | "rejected";
      readonly decidedBy: string;
      readonly reason?: string;
      readonly actorId?: never;
    };

/** The events a review policy decides; everything else is policy-independent. */
export type PolicyEvent = Extract<
  WorkflowEvent,
  { type: "submit" | "approve" | "request_changes" | "check_reported" | "gate_decided" }
>;

export type WorkflowEffect =
  | {
      readonly type: "notify";
      readonly audience: "supervisor" | "owner" | "assignee" | "reviewer";
      readonly message: string;
    }
  | { readonly type: "escalate"; readonly reason: string; readonly to: EscalationTarget }
  /** Ask the caller to run a named check and dispatch a "check_reported" event. */
  | { readonly type: "run_check"; readonly checkId: string }
  | {
      /**
       * Work crossing into another department. The engine creates nothing —
       * whoever holds a store performs this, which is also what lets a handoff
       * that cannot be placed be reported rather than half-happen.
       */
      readonly type: "hand_off";
      readonly connectionId: ConnectionId;
      readonly toDepartmentId: DepartmentId;
      readonly title: string;
      readonly brief: string;
      /** What is being handed on. Never the transcript. */
      readonly artifacts: readonly string[];
      readonly priority: TaskPriority;
      /** Where this work has been, including the department handing it on. */
      readonly route: readonly DepartmentId[];
      readonly assign: HandoffAssignment;
    }
  /** Put the task in the owner's approvals inbox and wait for a "gate_decided" event. */
  | {
      readonly type: "request_approval";
      readonly gates: readonly GatedAction[];
      readonly summary: string;
    };

export interface WorkflowOutcome {
  readonly task: Task;
  readonly effects: readonly WorkflowEffect[];
}

export interface PolicyHandler {
  readonly kind: string;
  handle(task: Task, event: PolicyEvent, context: WorkflowContext): Result<WorkflowOutcome>;
}

export function workflowError<T = WorkflowOutcome>(path: string, message: string): Result<T> {
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

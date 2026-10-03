/**
 * Shared workflow vocabulary. Policy handlers import only this module, so adding
 * a policy never creates an import cycle with the engine that registers it.
 */
import {
  err,
  transitionTask,
  type ConnectionId,
  type DepartmentId,
  type DocumentId,
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
  readonly departmentId: DepartmentId;
  readonly skillIds: readonly string[];
  /** Open tasks currently assigned, used to spread review load. */
  readonly openTasks: number;
}

export interface WorkflowContext {
  readonly policy: ReviewPolicy;
  readonly now: Date;
  /** Who reviews this department's work; null or absent when the office owner does. */
  readonly supervisorId?: EmployeeId | null;
  /** Colleagues eligible for peer review: this task's own department. */
  readonly peers?: readonly PeerCandidate[];
  /**
   * Everybody in the office, for the one thing that has to look outside the
   * task's own department: a department whose arrow says it checks this one's
   * work. Kept apart from `peers` so a peer review cannot accidentally reach
   * across the office.
   */
  readonly colleagues?: readonly PeerCandidate[];
  /** Skills the work needs, used to rank peer reviewers. */
  readonly reviewSkills?: readonly string[];
  /**
   * What this work has to achieve, already resolved from the task's own list or
   * its department's standing one. Read from here rather than reached for, the
   * same way the review policy is, so the engine never has to know what a
   * department is.
   */
  readonly acceptanceCriteria?: readonly string[];
  /**
   * What this work produced: the documents in its out-tray, already resolved by
   * the caller. Ids rather than bodies — the engine decides what travels, and
   * whoever holds a store does the carrying.
   */
  readonly documents?: readonly DocumentId[];
  /** Who work escalates to. Absent means everything escalates to the owner. */
  readonly escalationGraph?: EscalationGraph;
}

/**
 * One call a run is holding, named so a person can answer it.
 *
 * The same shape the pre-execution gate computes, repeated here rather than
 * imported because an event travels over HTTP between a worker and an office
 * and this is its wire form.
 */
export interface HeldCall {
  /** The tool_use id, or `run:spend` for the run's own spending. */
  readonly key: string;
  readonly name: string;
  readonly gates: readonly GatedAction[];
  /** One line for whoever is deciding. */
  readonly detail: string;
  /** The call's own arguments; empty for the run's spending. */
  readonly input: Readonly<Record<string, unknown>>;
}

export type WorkflowEvent =
  | { readonly type: "start"; readonly actorId?: EmployeeId }
  | {
      readonly type: "submit";
      readonly actorId: EmployeeId;
      readonly artifacts?: readonly string[];
      /**
       * The acceptance criteria this work claims to have met. Only a department
       * with no reviewer acts on it — everywhere else the reviewer answers the
       * list, not the person who did the work.
       */
      readonly met?: readonly string[];
    }
  | {
      readonly type: "approve";
      readonly actorId: EmployeeId;
      /** Which criteria the reviewer verified. Anything unlisted is not met. */
      readonly met?: readonly string[];
    }
  | { readonly type: "request_changes"; readonly actorId: EmployeeId; readonly reason: string }
  | {
      /**
       * Work changing hands. A transition rather than a field edit, and two of
       * them: `transferred`, then `assigned` to whoever has it now, because
       * that is the only way across the state machine from work in flight.
       */
      readonly type: "reassign";
      readonly toEmployeeId: EmployeeId;
      readonly reason?: string;
      /** Who moved it, when an employee did; absent when a person did. */
      readonly actorId?: EmployeeId;
    }
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
       * A run that stopped before a consequential call, waiting for a person.
       *
       * Distinct from `block`, which means a dependency and tells the
       * supervisor, and from the review gate, which holds finished work: this
       * is work in flight, stopped between the model asking for a tool and the
       * tool running. The items are the calls being held, each with its own
       * key, so a person approves one call with its arguments rather than
       * granting the task a category in advance.
       */
      readonly type: "await_decision";
      readonly actorId: EmployeeId;
      readonly summary: string;
      readonly items: readonly HeldCall[];
    }
  | {
      /**
       * A person's answer about one held call, dispatched by the application on
       * behalf of the authenticated human — never by an employee, which is the
       * whole point of holding it.
       *
       * Either answer starts the work again: a refusal is the answer to that
       * call, which the run hears and carries on from, not a cancellation of
       * the work.
       */
      readonly type: "call_decided";
      /** The tool call this is about, as the run named it. */
      readonly key: string;
      readonly decision: "approved" | "declined";
      readonly decidedBy: string;
      readonly reason?: string;
      readonly actorId?: never;
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
      readonly type: "create_work";
      /** Why this work exists: handed on by a department, or noticed by one. */
      readonly because: "handoff" | "watching";
      readonly connectionId: ConnectionId;
      readonly toDepartmentId: DepartmentId;
      readonly title: string;
      readonly brief: string;
      /** What is being handed on. Never the transcript. */
      readonly artifacts: readonly string[];
      /**
       * The documents to put in the new work's in-tray, as ids. Copied rather
       * than moved by whoever performs this, so both desks hold one, and both
       * copies name the one body that was written.
       */
      readonly documents: readonly DocumentId[];
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

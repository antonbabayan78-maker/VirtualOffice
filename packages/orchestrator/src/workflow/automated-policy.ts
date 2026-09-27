/**
 * Automated reviewer policy (plan §3, scenario 8).
 *
 * A check decides: the department names one (a test suite, a lint run, a
 * validation script) and submitted work is held in review until a report comes
 * back. A pass completes the task, a failure sends it back with the output as
 * the reason so the assignee has something to act on, and repeated failures run
 * into the same escalation cap as any other policy.
 *
 * A check that could not run is not a failure of the work, so it escalates to a
 * human instead of either approving or blaming the assignee. Nobody can approve
 * by hand under this policy: that is the point of automating the gate.
 *
 * The policy runs nothing itself. It emits a `run_check` effect and waits for a
 * `check_reported` event, which keeps the engine pure and testable.
 */
import type { Result, Task } from "@vo/core";
import { approveReview, requestChangesOrEscalate } from "./review-common.js";
import {
  applyTransition,
  workflowError,
  type PolicyEvent,
  type PolicyHandler,
  type WorkflowContext,
  type WorkflowOutcome,
} from "./workflow-types.js";

/** Check output beyond this is truncated before it is stored on the task. */
export const CHECK_OUTPUT_MAX_LENGTH = 2000;

function summarize(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length <= CHECK_OUTPUT_MAX_LENGTH) return trimmed;
  const dropped = trimmed.length - CHECK_OUTPUT_MAX_LENGTH;
  return `${trimmed.slice(0, CHECK_OUTPUT_MAX_LENGTH)}\n… (truncated, ${String(dropped)} more characters)`;
}

function configuredCheck(context: WorkflowContext): Result<string> {
  if (context.policy.kind !== "automated") {
    return workflowError<string>(
      "policy",
      `an automated reviewer needs a check to run; got "${context.policy.kind}"`,
    );
  }
  return { ok: true, value: context.policy.checkId };
}

function queueCheck(
  task: Task,
  event: Extract<PolicyEvent, { type: "submit" }>,
  context: WorkflowContext,
  checkId: string,
): Result<WorkflowOutcome> {
  const staged: Task = {
    ...task,
    // No human is being asked to look at this.
    reviewerIds: [],
    approvals: [],
    artifacts: [...task.artifacts, ...(event.artifacts ?? [])],
  };
  return applyTransition(staged, "in_review", event, context, [
    { type: "run_check", checkId },
    {
      type: "notify",
      audience: "owner",
      message: `check "${checkId}" queued for task "${task.title}"`,
    },
  ]);
}

function decide(
  task: Task,
  event: Extract<PolicyEvent, { type: "check_reported" }>,
  context: WorkflowContext,
  checkId: string,
): Result<WorkflowOutcome> {
  const { report } = event;
  if (report.checkId !== checkId) {
    return workflowError(
      "report.checkId",
      `this department's automated reviewer runs "${checkId}", not "${report.checkId}"`,
    );
  }
  if (task.status !== "in_review") {
    return workflowError(
      "status",
      `a check only decides work that is in review; this task is "${task.status}"`,
    );
  }

  const summary = summarize(report.output);
  switch (report.outcome) {
    case "passed":
      return approveReview(task, event, context);
    case "failed":
      return requestChangesOrEscalate(
        task,
        event,
        context,
        summary.length > 0 ? summary : `check "${checkId}" failed without output`,
      );
    case "errored": {
      const reason = `check "${checkId}" could not run: ${summary.length > 0 ? summary : "no output"}`;
      return applyTransition(
        task,
        "escalated",
        event,
        context,
        [
          { type: "escalate", reason },
          {
            type: "notify",
            audience: "owner",
            message: `task "${task.title}" needs a human: ${reason}`,
          },
        ],
        reason,
      );
    }
  }
}

export const AUTOMATED_POLICY_HANDLER: PolicyHandler = {
  kind: "automated",
  handle(task, event, context) {
    const checkId = configuredCheck(context);
    if (!checkId.ok) return checkId;

    switch (event.type) {
      case "submit":
        return queueCheck(task, event, context, checkId.value);
      case "check_reported":
        return decide(task, event, context, checkId.value);
      case "approve":
      case "request_changes":
        return workflowError(
          "event",
          `check "${checkId.value}" decides this task; report the check result rather than ` +
            `reviewing it by hand`,
        );
    }
  },
};

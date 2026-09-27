/**
 * Multi-stage pipeline policy (plan §3, scenario 6).
 *
 * A department declares an ordered chain of stages — Draft -> QA -> Legal ->
 * Publish. Each stage has a worker who does that stage's work and reviewers who
 * sign it off, and a stage may need several approvals. Clearing a stage does not
 * finish the task: the work is handed to the next stage's worker, and only the
 * final stage completes it. Changes requested at a stage send the work back to
 * that stage's worker and the pipeline stays where it is, so earlier stages are
 * not re-reviewed over a late nit. The escalation cap counts change-request
 * rounds across the whole pipeline, as it does under every other policy.
 *
 * The current stage lives on the task as a stage name, so the canvas can show
 * where the work is and a renamed or dropped stage fails loudly instead of
 * silently restarting the chain.
 */
import type { ReviewStage, Result, Task } from "@vo/core";
import {
  rejectPolicyEvent,
  requestChangesOrEscalate,
  submitForReview,
  supervisorChoice,
  tallyApproval,
} from "./review-common.js";
import {
  applyTransition,
  workflowError,
  type PolicyEvent,
  type PolicyHandler,
  type WorkflowContext,
  type WorkflowOutcome,
} from "./workflow-types.js";

function pipelineStages(context: WorkflowContext): Result<readonly ReviewStage[]> {
  if (context.policy.kind !== "pipeline") {
    return workflowError<readonly ReviewStage[]>(
      "policy",
      `a pipeline policy needs ordered stages; got "${context.policy.kind}"`,
    );
  }
  return { ok: true, value: context.policy.stages };
}

interface StagePosition {
  readonly stage: ReviewStage;
  readonly index: number;
}

/** Where the work stands in the chain: its recorded stage, or the first one. */
function locate(task: Task, stages: readonly ReviewStage[]): Result<StagePosition> {
  const first = stages[0];
  if (first === undefined) {
    return workflowError<StagePosition>("policy", "a pipeline policy needs at least one stage");
  }
  const name = task.stage ?? first.name;
  const index = stages.findIndex((candidate) => candidate.name === name);
  const stage = stages[index];
  if (stage === undefined) {
    return workflowError<StagePosition>(
      "stage",
      `the task is at stage "${name}", which this department's pipeline no longer ` +
        `declares; its stages are ${stages.map((s) => s.name).join(" -> ")}`,
    );
  }
  return { ok: true, value: { stage, index } };
}

function enterStage(
  task: Task,
  event: Extract<PolicyEvent, { type: "submit" }>,
  context: WorkflowContext,
  stage: ReviewStage,
): Result<WorkflowOutcome> {
  const staged: Task = {
    ...task,
    stage: stage.name,
    assigneeId: stage.workerId ?? task.assigneeId,
  };
  if (stage.reviewerIds.length > 0) {
    return submitForReview(staged, event, context, {
      reviewerIds: stage.reviewerIds,
      audience: "reviewer",
    });
  }
  const fallback = supervisorChoice(staged, context);
  if (!fallback.ok) return fallback;
  return submitForReview(staged, event, context, fallback.value);
}

function signOffStage(
  task: Task,
  event: Extract<PolicyEvent, { type: "approve" }>,
  context: WorkflowContext,
  { stage, index }: StagePosition,
  stages: readonly ReviewStage[],
): Result<WorkflowOutcome> {
  const tally = tallyApproval(task, event, stage.required);
  if (!tally.ok) return tally;
  if (!tally.value.reached) {
    return {
      ok: true,
      value: {
        task: tally.value.task,
        effects: [
          {
            type: "notify",
            audience: "reviewer",
            message:
              `stage "${stage.name}" of "${task.title}" has ` +
              `${String(tally.value.gathered)} of ${String(stage.required)} approvals`,
          },
        ],
      },
    };
  }

  const approved = applyTransition(tally.value.task, "approved", event, context);
  if (!approved.ok) return approved;

  const next = stages[index + 1];
  if (next === undefined) {
    return applyTransition(approved.value.task, "done", event, context, [
      {
        type: "notify",
        audience: "assignee",
        message: `task "${task.title}" cleared its final stage "${stage.name}"`,
      },
    ]);
  }

  const handed: Task = {
    ...approved.value.task,
    stage: next.name,
    assigneeId: next.workerId ?? approved.value.task.assigneeId,
    reviewerIds: [],
    approvals: [],
  };
  return applyTransition(
    handed,
    "assigned",
    event,
    context,
    [
      {
        type: "notify",
        audience: "assignee",
        message: `"${task.title}" cleared stage "${stage.name}" and moves to "${next.name}"`,
      },
    ],
    `cleared stage "${stage.name}"`,
  );
}

export const PIPELINE_POLICY_HANDLER: PolicyHandler = {
  kind: "pipeline",
  handle(task, event, context) {
    const stages = pipelineStages(context);
    if (!stages.ok) return stages;
    const position = locate(task, stages.value);
    if (!position.ok) return position;
    const { stage } = position.value;

    switch (event.type) {
      case "submit":
        return enterStage(task, event, context, stage);
      case "approve":
        return signOffStage(task, event, context, position.value, stages.value);
      case "request_changes":
        // Back to whoever owns this stage's work, with the stage unchanged.
        return requestChangesOrEscalate(
          { ...task, assigneeId: stage.workerId ?? task.assigneeId },
          event,
          context,
          event.reason,
        );
      case "check_reported":
      case "gate_decided":
        return rejectPolicyEvent("pipeline", event);
    }
  },
};

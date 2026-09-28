/**
 * One employee's turn: what an agent does when its name comes up.
 *
 * Two turns exist, and they are not the same job. Doing the work ends in a
 * submission; reviewing somebody else's ends in a verdict. A reviewer is given
 * only the review tool, so it cannot quietly redo the work it was asked to
 * judge.
 *
 * A turn returns events rather than applying them. The workflow engine owns
 * what a task may do next — an agent proposes, the policy disposes — and that
 * separation is what lets the same turn run inside a headless `vo run` and
 * inside a worker that reports over HTTP, with no second opinion about how
 * review works.
 *
 * Anything the model did not clearly say is not assumed. A review that is not
 * an approval is changes requested; a run that ended without calling the submit
 * tool submits nothing. Reading a vague answer generously is how work gets
 * approved that nobody approved.
 */
import type { DepartmentId, Employee, EmployeeId, OfficeId, Task, TaskId } from "@vo/core";
import type { LlmProvider, ToolDefinition } from "@vo/llm";
import { AGENT_REVIEW_JOB, type AGENT_RUN_JOB } from "../schedule/scheduler.js";
import type { WorkflowEvent } from "../workflow/workflow-types.js";
import { runAgent } from "./agent-run-loop.js";

/** What an employee calls to hand finished work over. */
export const SUBMIT_TOOL: ToolDefinition = {
  name: "submit_work",
  description: "Hand the finished work over for review.",
  inputSchema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  },
};

/** What a reviewer calls to decide. */
export const REVIEW_TOOL: ToolDefinition = {
  name: "review_verdict",
  description: "Approve the work, or send it back with a reason.",
  inputSchema: {
    type: "object",
    properties: { approved: { type: "boolean" }, reason: { type: "string" } },
    required: ["approved"],
  },
};

export type TurnKind = typeof AGENT_RUN_JOB | typeof AGENT_REVIEW_JOB;

export interface AgentTurnRequest {
  readonly task: Task;
  /** Whose turn it is: the assignee for a run, the reviewer for a review. */
  readonly actor: Employee;
  readonly kind: TurnKind;
}

/** Who a call is on behalf of, for metering. */
export interface TurnAttribution {
  readonly officeId: OfficeId;
  readonly departmentId: DepartmentId;
  readonly employeeId: EmployeeId;
  readonly taskId: TaskId;
}

export interface AgentTurnOptions {
  readonly provider: LlmProvider;
  /**
   * Wraps the provider for this particular turn — metering, in practice. Passed
   * in rather than imported so the orchestrator does not depend on telemetry.
   */
  readonly wrapProvider?: (provider: LlmProvider, attribution: TurnAttribution) => LlmProvider;
  readonly maxSteps?: number;
}

export type AgentTurn = (request: AgentTurnRequest) => Promise<readonly WorkflowEvent[]>;

export function llmAgentTurn(options: AgentTurnOptions): AgentTurn {
  return async ({ task, actor, kind }) => {
    const reviewing = kind === AGENT_REVIEW_JOB;
    const resultTool = reviewing ? REVIEW_TOOL : SUBMIT_TOOL;
    const attribution: TurnAttribution = {
      officeId: task.officeId,
      departmentId: task.departmentId,
      employeeId: actor.id,
      taskId: task.id,
    };
    const provider = options.wrapProvider?.(options.provider, attribution) ?? options.provider;

    const instruction = reviewing
      ? `Review the work on this task and call ${REVIEW_TOOL.name} with your decision.`
      : `Do the work described and call ${SUBMIT_TOOL.name} when it is finished.`;

    const result = await runAgent({
      provider,
      model: actor.llm.model,
      system: {
        stable: [`You are ${actor.name}, ${actor.role}.`],
        dynamic: [`Task: ${task.title}`],
      },
      messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
      tools: [],
      resultTool,
      executeTool: () => Promise.resolve({ content: "" }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    });

    const verdict = result.structuredResult;

    if (reviewing) {
      if (verdict === undefined) return [];
      // Strictly true, so a loosely worded answer is never read as a yes.
      if (verdict["approved"] === true) return [{ type: "approve", actorId: actor.id }];
      const reason = typeof verdict["reason"] === "string" ? verdict["reason"] : "changes needed";
      return [{ type: "request_changes", actorId: actor.id, reason }];
    }

    // Starting is a transition of its own, so the canvas sees work begin rather
    // than a task that jumps straight from assigned to in review.
    const events: WorkflowEvent[] =
      task.status === "assigned" ? [{ type: "start", actorId: actor.id }] : [];
    if (verdict === undefined) return events;

    const summary = typeof verdict["summary"] === "string" ? verdict["summary"] : "work submitted";
    return [...events, { type: "submit", actorId: actor.id, artifacts: [summary] }];
  };
}

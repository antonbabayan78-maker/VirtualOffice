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
/**
 * How the acceptance criteria are written into a prompt.
 *
 * Exported because a rehearsal has to answer the question it was asked, and
 * scraping a sentence it does not own would break the first time this wording
 * changed.
 */
export const CRITERIA_PREFIX = "This work is done when:";
export const CRITERIA_SEPARATOR = " | ";

export const SUBMIT_TOOL: ToolDefinition = {
  name: "submit_work",
  description: "Hand the finished work over for review.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      met: {
        type: "array",
        items: { type: "string" },
        description: "Each acceptance criterion this work meets, copied exactly.",
      },
    },
    required: ["summary"],
  },
};

/** What a reviewer calls to decide. */
export const REVIEW_TOOL: ToolDefinition = {
  name: "review_verdict",
  description: "Approve the work, or send it back with a reason.",
  inputSchema: {
    type: "object",
    properties: {
      approved: { type: "boolean" },
      reason: { type: "string" },
      met: {
        type: "array",
        items: { type: "string" },
        description: "Each acceptance criterion you have verified, copied exactly.",
      },
    },
    required: ["approved"],
  },
};

export type TurnKind = typeof AGENT_RUN_JOB | typeof AGENT_REVIEW_JOB;

export interface AgentTurnRequest {
  readonly task: Task;
  /** What this work has to achieve, already resolved by whoever asked. */
  readonly acceptanceCriteria?: readonly string[];
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
  return async ({ task, actor, kind, acceptanceCriteria = [] }) => {
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
      ? `Review the work on this task and call ${REVIEW_TOOL.name} with your decision.` +
        (acceptanceCriteria.length === 0
          ? ""
          : ` List in "met" every criterion you have verified, copied exactly. Anything you` +
            ` leave out is treated as not met, and the work goes back.`)
      : `Do the work described and call ${SUBMIT_TOOL.name} when it is finished.`;

    // Dynamic rather than stable: the list belongs to this task, and the stable
    // half is what prompt caching keeps between calls.
    const dynamic = [`Task: ${task.title}`];
    if (acceptanceCriteria.length > 0) {
      dynamic.push(`${CRITERIA_PREFIX} ${acceptanceCriteria.join(CRITERIA_SEPARATOR)}`);
    }

    const result = await runAgent({
      provider,
      model: actor.llm.model,
      system: {
        stable: [`You are ${actor.name}, ${actor.role}.`],
        dynamic,
      },
      messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
      tools: [],
      resultTool,
      executeTool: () => Promise.resolve({ content: "" }),
      ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    });

    const verdict = result.structuredResult;

    // Only text survives. A model answering "all of them" has claimed nothing,
    // which is the safe reading: silence about a criterion is not assent.
    const claimed = (raw: unknown): readonly string[] =>
      Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];

    if (reviewing) {
      if (verdict === undefined) return [];
      // Strictly true, so a loosely worded answer is never read as a yes.
      if (verdict["approved"] === true) {
        return [{ type: "approve", actorId: actor.id, met: claimed(verdict["met"]) }];
      }
      const reason = typeof verdict["reason"] === "string" ? verdict["reason"] : "changes needed";
      return [{ type: "request_changes", actorId: actor.id, reason }];
    }

    // Starting is a transition of its own, so the canvas sees work begin rather
    // than a task that jumps straight from assigned to in review.
    const events: WorkflowEvent[] =
      task.status === "assigned" ? [{ type: "start", actorId: actor.id }] : [];
    if (verdict === undefined) return events;

    const summary = typeof verdict["summary"] === "string" ? verdict["summary"] : "work submitted";
    return [
      ...events,
      { type: "submit", actorId: actor.id, artifacts: [summary], met: claimed(verdict["met"]) },
    ];
  };
}

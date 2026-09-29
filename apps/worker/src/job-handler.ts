/**
 * Turning a queued job into something that happened to a task.
 *
 * The shape is deliberately narrow: read the task and the employee whose turn
 * it is from the office, let the agent decide, and hand each decision back to
 * the office as an event. The office applies its own review policy, so a worker
 * cannot move a task somewhere the policy forbids — it can only report what its
 * agent did.
 *
 * Reading through the API rather than storage keeps the server the only writer.
 * A worker with its own database connection would be a second one, and the two
 * would disagree the moment somebody moved a task on the canvas.
 *
 * Failures are split by whether coming back would help. A network that was not
 * there throws, so the queue retries. An event the office refused does not: it
 * would be refused identically forever, and a job that can never succeed is
 * better reported than retried until it runs out of attempts.
 */
import type { ApiClient, ApiResult } from "@vo/api-client";
import {
  acceptanceCriteriaFor,
  AGENT_RUN_JOB,
  AGENT_REVIEW_JOB,
  type AgentTurn,
  type HandedOver,
  type Job,
} from "@vo/orchestrator";

export interface JobHandlerOptions {
  readonly api: ApiClient;
  readonly agent: AgentTurn;
  /** Told about work that was dropped on purpose, so nothing vanishes quietly. */
  readonly onProblem?: (message: string) => void;
}

const AGENT_JOBS: readonly string[] = [AGENT_RUN_JOB, AGENT_REVIEW_JOB];

/**
 * What this work was handed, as text a prompt can carry.
 *
 * Only what can be read as text: a model cannot be shown bytes, and a document
 * it cannot read is better left out than described. An office that cannot say
 * what is in a tray leaves the turn with nothing rather than stopping it — the
 * work is still doable, just less informed.
 */
async function handedOver(
  api: ApiClient,
  officeId: string,
  taskId: string,
): Promise<readonly HandedOver[]> {
  const held = await api.listDocuments(officeId, {
    ownerKind: "task",
    ownerId: taskId,
    tray: "in",
  });
  if (!held.ok) return [];

  const decoder = new TextDecoder();
  const read = await Promise.all(
    held.value
      .filter((document) => document.mediaType.startsWith("text/"))
      .map(async (document) => {
        const body = await api.downloadDocument(document.id);
        return body.ok ? { name: document.name, text: decoder.decode(body.value) } : null;
      }),
  );
  return read.filter((one): one is HandedOver => one !== null);
}

export function officeJobHandler(options: JobHandlerOptions): (job: Job) => Promise<void> {
  return async (job) => {
    if (!AGENT_JOBS.includes(job.kind)) {
      // Not ours — a recurring definition may queue any kind it likes.
      options.onProblem?.(`no handler for job kind ${job.kind}; leaving it alone`);
      return;
    }

    const taskId = job.payload["taskId"];
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error(`job ${job.id} of kind ${job.kind} has no taskId to work on`);
    }
    if (job.employeeId === null) {
      throw new Error(`job ${job.id} of kind ${job.kind} names no employee to do it`);
    }

    const task = await options.api.getTask(taskId);
    if (!task.ok) throw new Error(`could not read task ${taskId}: ${describe(task)}`);

    const actor = await options.api.getEmployee(job.employeeId);
    if (!actor.ok) {
      throw new Error(`could not read employee ${job.employeeId}: ${describe(actor)}`);
    }

    // What done means here, asked of the office rather than assumed. A
    // department it cannot read leaves no list rather than stopping the work.
    const department = await options.api.getDepartment(task.value.departmentId);
    const acceptanceCriteria = acceptanceCriteriaFor(
      task.value.acceptanceCriteria,
      department.ok ? department.value.definitionOfDone : [],
    );

    const events = await options.agent({
      task: task.value,
      actor: actor.value,
      kind: job.kind as typeof AGENT_RUN_JOB | typeof AGENT_REVIEW_JOB,
      acceptanceCriteria,
      documents: await handedOver(options.api, task.value.officeId, taskId),
    });

    for (const event of events) {
      const posted = await options.api.postTaskEvent(taskId, event);
      if (posted.ok) continue;

      if (posted.kind === "transport") {
        throw new Error(`could not tell the office about task ${taskId}: ${posted.message}`);
      }
      // Refused, not lost. Whatever the turn decided after this was decided
      // about a task that never moved, so none of it is reported either.
      options.onProblem?.(`the office refused ${event.type} on ${taskId}: ${describe(posted)}`);
      return;
    }
  };
}

/** Says what went wrong the same way wherever it is logged. */
function describe(result: Extract<ApiResult<unknown>, { ok: false }>): string {
  if (result.kind === "validation") {
    return result.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
  }
  if (result.kind === "conflict") return "it changed while this was being decided";
  return result.message;
}

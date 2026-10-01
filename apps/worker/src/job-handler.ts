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
import { officeBroker } from "@vo/connectors";
import type { Connector, ToolGrant } from "@vo/core";
import {
  acceptanceCriteriaFor,
  catalogFor,
  AGENT_JUDGE_JOB,
  AGENT_RUN_JOB,
  AGENT_REVIEW_JOB,
  type AgentTurn,
  type ContestEntry,
  type HandedOver,
  type JudgeTurn,
  type ToolCatalog,
  type Job,
} from "@vo/orchestrator";

export interface JobHandlerOptions {
  readonly api: ApiClient;
  readonly agent: AgentTurn;
  /**
   * Decides a shootout. Absent means this worker does not judge: those jobs are
   * left alone and said out loud, rather than failing on every attempt.
   */
  readonly judge?: JudgeTurn;
  /** Told about work that was dropped on purpose, so nothing vanishes quietly. */
  readonly onProblem?: (message: string) => void;
}

const AGENT_JOBS: readonly string[] = [AGENT_RUN_JOB, AGENT_REVIEW_JOB];

/**
 * Everything this employee may call, named as the model will see it.
 *
 * Built per job rather than per worker because it depends on whose turn it is,
 * and asked of the connectors themselves because only they know what they offer.
 */
async function catalogueFor(
  connectors: readonly Connector[],
  departmentGrants: readonly ToolGrant[],
  employeeGrants: readonly ToolGrant[],
): Promise<ToolCatalog> {
  const described = await officeBroker(connectors).describe();
  return catalogFor({ connectors, departmentGrants, employeeGrants }, described);
}

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
  tray: "in" | "out" = "in",
): Promise<readonly HandedOver[]> {
  const held = await api.listDocuments(officeId, {
    ownerKind: "task",
    ownerId: taskId,
    tray,
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

/**
 * Deciding one contest: read its entries and their answers, let the judge
 * choose, and tell the office.
 *
 * The entries are read out of the office rather than carried in the job, for the
 * reason everything else about a contest is derived: the office is where they
 * live, and a payload listing them would be a copy that could go stale between
 * being queued and being done.
 */
async function judgeContest(options: JobHandlerOptions, job: Job): Promise<void> {
  const judge = options.judge;
  if (judge === undefined) {
    options.onProblem?.(`this worker has no judge, so ${job.id} is left for somebody who has`);
    return;
  }
  const contestId = job.payload["contestId"];
  if (typeof contestId !== "string" || contestId.length === 0) {
    throw new Error(`job ${job.id} of kind ${job.kind} names no contest to decide`);
  }
  if (job.employeeId === null) {
    throw new Error(`job ${job.id} of kind ${job.kind} names nobody to judge it`);
  }

  const office = await options.api.loadOffice(job.officeId);
  if (!office.ok) throw new Error(`could not read office ${job.officeId}: ${describe(office)}`);

  const entries = office.value.tasks.filter((task) => task.contestId === contestId);
  const first = entries[0];
  if (first === undefined) {
    throw new Error(`contest ${contestId} has no entries in office ${job.officeId}`);
  }

  const actor = await options.api.getEmployee(job.employeeId);
  if (!actor.ok) throw new Error(`could not read employee ${job.employeeId}: ${describe(actor)}`);

  const people = new Map(office.value.employees.map((one) => [one.id as string, one]));
  const department = await options.api.getDepartment(first.departmentId);

  const answers: ContestEntry[] = [];
  for (const entry of entries) {
    const who = entry.assigneeId === null ? undefined : people.get(entry.assigneeId);
    answers.push({
      taskId: entry.id,
      // Kept for the record this returns, and never shown to the judge: a judge
      // that knows which answer is the expensive model is not judging the answer.
      who: who?.name ?? "somebody who has left",
      model: who?.llm.model ?? "unknown",
      outputs: await handedOver(options.api, job.officeId, entry.id, "out"),
    });
  }

  const verdict = await judge({
    officeId: first.officeId,
    departmentId: first.departmentId,
    contestId: contestId as (typeof entries)[number]["contestId"] & string,
    question: first.title,
    criteria: acceptanceCriteriaFor(
      first.acceptanceCriteria,
      department.ok ? department.value.definitionOfDone : [],
    ),
    entries: answers,
    judge: actor.value,
  });

  if (verdict === null) {
    // Nothing is assumed from a model that did not answer clearly, and a person
    // can still decide this one on the canvas.
    options.onProblem?.(`the judge decided nothing about contest ${contestId}`);
    return;
  }

  const recorded = await options.api.recordContestWin(verdict.winnerTaskId, {
    reason: verdict.reason,
    decidedBy: job.employeeId,
  });
  if (recorded.ok) return;
  if (recorded.kind === "transport") {
    throw new Error(`could not tell the office about contest ${contestId}: ${recorded.message}`);
  }
  // Refused, which "already decided" is when a person got there first. Coming
  // back would be refused identically every time.
  options.onProblem?.(
    `the office refused a verdict on contest ${contestId}: ${describe(recorded)}`,
  );
}

export function officeJobHandler(options: JobHandlerOptions): (job: Job) => Promise<void> {
  return async (job) => {
    if (job.kind === AGENT_JUDGE_JOB) {
      await judgeContest(options, job);
      return;
    }
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

    // What this office can reach, and what this employee may reach of it. An
    // office that cannot say has no tools rather than a job that fails.
    const listed = await options.api.listConnectors(task.value.officeId);
    const connectors: readonly Connector[] = listed.ok ? listed.value : [];
    const departmentGrants = department.ok ? department.value.toolGrants : [];
    const grants: readonly ToolGrant[] = [...departmentGrants, ...actor.value.toolGrants];

    const events = await options.agent({
      task: task.value,
      actor: actor.value,
      kind: job.kind as typeof AGENT_RUN_JOB | typeof AGENT_REVIEW_JOB,
      acceptanceCriteria,
      documents: await handedOver(options.api, task.value.officeId, taskId),
      toolCatalog: await catalogueFor(connectors, departmentGrants, actor.value.toolGrants),
      connectors,
      toolGrants: grants,
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

/**
 * Headless office run: the P1 gate (plan §12).
 *
 * This is where the parts meet. The scheduler says what is due, the queue hands
 * it out, the worker runs it, the run loop drives the agent, the workflow engine
 * decides what the result means, and telemetry counts what it cost. Everything
 * below is wiring; the behaviour lives in those packages and is tested there.
 *
 * The run ends when the office goes quiet — no due work and an empty queue —
 * rather than after a fixed number of ticks, so a run costs what the work costs.
 * A cap remains, because an office that never settles must not spin forever.
 *
 * Tasks are held in memory here. Persisting them is the server's job; a headless
 * run is meant to be reproducible from an office file and a brief.
 */
import {
  transitionTask,
  type EmployeeId,
  type OfficeConfig,
  type Task,
  type TaskId,
} from "@vo/core";
import { defaultModelRegistry, type LlmProvider, type ModelRegistry } from "@vo/llm";
import {
  AGENT_REVIEW_JOB,
  AGENT_RUN_JOB,
  InProcessJobQueue,
  Worker,
  defaultWorkflowEngine,
  llmAgentTurn,
  type Job,
  type RunnableTask,
  type SchedulerSnapshot,
  type WorkflowContext,
  type WorkflowEffect,
  type WorkflowEvent,
} from "@vo/orchestrator";
import {
  InMemoryUsageSink,
  UsageRecorder,
  meterProvider,
  type UsageEvent,
  type UsageSink,
} from "@vo/telemetry";

export interface OfficeRunOptions {
  readonly config: OfficeConfig;
  readonly tasks: readonly Task[];
  readonly provider: LlmProvider;
  readonly registry?: ModelRegistry;
  readonly sink?: UsageSink;
  readonly now?: () => Date;
  /** Stops a run that never settles. */
  readonly maxTicks?: number;
}

export interface OfficeRunResult {
  readonly ticks: number;
  readonly tasks: readonly Task[];
  readonly usage: readonly UsageEvent[];
  readonly effects: readonly WorkflowEffect[];
  readonly done: number;
}

export const DEFAULT_MAX_TICKS = 50;

export async function runOffice(options: OfficeRunOptions): Promise<OfficeRunResult> {
  const now = options.now ?? (() => new Date());
  const maxTicks = Math.max(1, options.maxTicks ?? DEFAULT_MAX_TICKS);
  const config = options.config;

  const tasks = new Map<TaskId, Task>(options.tasks.map((task) => [task.id, task]));
  const employees = new Map(config.employees.map((e) => [e.id as string, e]));
  const departments = new Map(config.departments.map((d) => [d.id as string, d]));

  const sink = options.sink ?? new InMemoryUsageSink();
  const recorder = new UsageRecorder({
    sink,
    registry: options.registry ?? defaultModelRegistry(),
    now: () => now().getTime(),
  });

  const engine = defaultWorkflowEngine();
  const effects: WorkflowEffect[] = [];
  const queue = new InProcessJobQueue(
    { limits: { maxPerEmployee: 1 } },
    {
      now: () => now().getTime(),
    },
  );

  /** The escalation ladder the office file describes. */
  const escalationGraph = {
    employees: config.employees.map((e) => ({
      id: e.id,
      departmentId: e.departmentId,
      supervisorId: e.supervisorId,
      status: e.status,
    })),
    connections: config.connections,
  };

  const contextFor = (task: Task, employeeId: EmployeeId | null): WorkflowContext => {
    const department = departments.get(task.departmentId);
    const employee = employeeId === null ? undefined : employees.get(employeeId);
    const assignee = task.assigneeId === null ? undefined : employees.get(task.assigneeId);
    return {
      policy: department?.reviewPolicy ?? { kind: "direct" },
      now: now(),
      supervisorId: assignee?.supervisorId ?? employee?.supervisorId ?? null,
      peers: config.employees
        .filter((e) => e.departmentId === task.departmentId)
        .map((e) => ({ id: e.id, status: e.status, skillIds: e.skillIds, openTasks: 0 })),
      escalationGraph,
    };
  };

  const dispatch = (task: Task, event: WorkflowEvent, actor: EmployeeId | null): Task => {
    const outcome = engine.handle(task, event, contextFor(task, actor));
    if (!outcome.ok) {
      // A refused transition is the engine telling us the office is not in the
      // state we thought; leave the task alone and let the next tick decide.
      return task;
    }
    effects.push(...outcome.value.effects);
    tasks.set(outcome.value.task.id, outcome.value.task);
    return outcome.value.task;
  };

  /**
   * The same turn the worker takes, so `vo run` and a deployed worker cannot
   * end up with two different ideas of what an employee does when its name
   * comes up. Metering is wrapped in here because attribution is per turn.
   */
  const turn = llmAgentTurn({
    provider: options.provider,
    wrapProvider: (provider, attribution) => meterProvider(provider, { recorder, attribution }),
  });

  const handle = async (job: Job): Promise<void> => {
    if (job.kind !== AGENT_RUN_JOB && job.kind !== AGENT_REVIEW_JOB) return;

    const taskId = job.payload["taskId"] as TaskId | undefined;
    const task = taskId === undefined ? undefined : tasks.get(taskId);
    if (task === undefined || job.employeeId === null) return;
    const actor = employees.get(job.employeeId);
    if (actor === undefined) return;

    let current = task;
    for (const event of await turn({ task: current, actor, kind: job.kind })) {
      // Each event is applied to where the last one left the task; a refused
      // one leaves it untouched and the next is judged against that.
      current = dispatch(current, event, job.employeeId);
    }
  };

  const snapshot = (): SchedulerSnapshot => ({
    offices: [{ id: config.office.id, schedule: config.office.schedule }],
    departments: config.departments.map((d) => ({
      id: d.id,
      officeId: d.officeId,
      schedule: d.schedule,
    })),
    employees: config.employees.map((e) => ({
      id: e.id,
      officeId: e.officeId,
      departmentId: e.departmentId,
      status: e.status,
      schedule: e.schedule ?? { kind: "always" },
    })),
    tasks: [...tasks.values()].map((task): RunnableTask => ({
      id: task.id,
      officeId: task.officeId,
      departmentId: task.departmentId,
      assigneeId: task.assigneeId,
      status: task.status,
      priority: task.priority,
      reviewerIds: task.reviewerIds,
      revision: task.history.length,
    })),
    recurring: [],
  });

  const worker = new Worker({
    id: "vo-run",
    queue,
    snapshot: () => Promise.resolve(snapshot()),
    handle,
    now,
  });

  let ticks = 0;
  while (ticks < maxTicks) {
    const report = await worker.tick();
    ticks += 1;
    const pending = await queue.stats();
    // Quiet means nothing was queued, nothing ran, and nothing is waiting.
    if (report.enqueued === 0 && report.processed === 0 && pending.pending === 0) break;
  }

  const finished = [...tasks.values()];
  return {
    ticks,
    tasks: finished,
    usage: sink instanceof InMemoryUsageSink ? sink.events : [],
    effects,
    done: finished.filter((task) => task.status === "done").length,
  };
}

/** Exported for the command layer and for tests that build their own task. */
export { transitionTask };

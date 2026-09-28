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
import {
  defaultModelRegistry,
  type LlmProvider,
  type ModelRegistry,
  type ToolDefinition,
} from "@vo/llm";
import {
  AGENT_REVIEW_JOB,
  AGENT_RUN_JOB,
  InProcessJobQueue,
  Worker,
  defaultWorkflowEngine,
  runAgent,
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

/** What an employee calls when the work is done. */
const SUBMIT_TOOL: ToolDefinition = {
  name: "submit_work",
  description: "Hand the finished work over for review.",
  inputSchema: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
  },
};

/** What a reviewer calls to decide. */
const REVIEW_TOOL: ToolDefinition = {
  name: "review_verdict",
  description: "Approve the work, or send it back with a reason.",
  inputSchema: {
    type: "object",
    properties: { approved: { type: "boolean" }, reason: { type: "string" } },
    required: ["approved"],
  },
};

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

  const askAgent = async (
    employeeId: EmployeeId,
    task: Task,
    instruction: string,
    resultTool: ToolDefinition,
  ): Promise<Readonly<Record<string, unknown>> | undefined> => {
    const employee = employees.get(employeeId);
    if (employee === undefined) return undefined;
    const metered = meterProvider(options.provider, {
      recorder,
      attribution: {
        officeId: task.officeId,
        departmentId: task.departmentId,
        employeeId,
        taskId: task.id,
      },
    });

    const result = await runAgent({
      provider: metered,
      model: employee.llm.model,
      system: {
        stable: [`You are ${employee.name}, ${employee.role}.`],
        dynamic: [`Task: ${task.title}`],
      },
      messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
      tools: [],
      resultTool,
      executeTool: () => Promise.resolve({ content: "" }),
    });
    return result.structuredResult;
  };

  const handle = async (job: Job): Promise<void> => {
    const taskId = job.payload["taskId"] as TaskId | undefined;
    const task = taskId === undefined ? undefined : tasks.get(taskId);
    if (task === undefined || job.employeeId === null) return;

    if (job.kind === AGENT_RUN_JOB) {
      // Starting is a transition of its own, so the canvas can see work begin.
      const started =
        task.status === "assigned"
          ? dispatch(task, { type: "start", actorId: job.employeeId }, job.employeeId)
          : task;
      const verdict = await askAgent(
        job.employeeId,
        started,
        `Do the work described and call ${SUBMIT_TOOL.name} when it is finished.`,
        SUBMIT_TOOL,
      );
      if (verdict === undefined) return;
      const summary =
        typeof verdict["summary"] === "string" ? verdict["summary"] : "work submitted";
      dispatch(
        tasks.get(started.id) ?? started,
        { type: "submit", actorId: job.employeeId, artifacts: [summary] },
        job.employeeId,
      );
      return;
    }

    if (job.kind === AGENT_REVIEW_JOB) {
      const verdict = await askAgent(
        job.employeeId,
        task,
        `Review the work and call ${REVIEW_TOOL.name} with your decision.`,
        REVIEW_TOOL,
      );
      if (verdict === undefined) return;
      const approved = verdict["approved"] === true;
      const reason = typeof verdict["reason"] === "string" ? verdict["reason"] : "changes needed";
      const current = tasks.get(task.id) ?? task;
      dispatch(
        current,
        approved
          ? { type: "approve", actorId: job.employeeId }
          : { type: "request_changes", actorId: job.employeeId, reason },
        job.employeeId,
      );
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

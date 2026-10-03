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
  isErr,
  openTaskCounts,
  transitionTask,
  type Employee,
  type EmployeeId,
  type GatedAction,
  type Document,
  type DocumentId,
  type OfficeConfig,
  type Task,
  type TaskId,
} from "@vo/core";
import { defaultModelRegistry, type LlmProvider, type ModelRegistry } from "@vo/llm";
import {
  AGENT_REVIEW_JOB,
  AGENT_RUN_JOB,
  InMemoryRunCheckpointStore,
  InProcessJobQueue,
  Worker,
  defaultWorkflowEngine,
  catalogFor,
  llmAgentTurn,
  type ApprovalDecision,
  type DocumentSink,
  type HandedOver,
  type HeldCall,
  type Job,
  acceptanceCriteriaFor,
  gatesAwaiting,
  officeSnapshot,
  performCreateWork,
  type PeerCandidate,
  type SchedulerSnapshot,
  type WorkflowContext,
  type WorkflowEffect,
  type WorkflowEvent,
} from "@vo/orchestrator";
import { officeBroker, type WebFetch } from "@vo/connectors";
import {
  InMemoryBlobStore,
  InMemoryRelationalStore,
  copyIntoTray,
  fileDocument,
  listTray,
  readDocument,
} from "@vo/storage";
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
  /** Ids for work the office creates for itself, such as a handoff. */
  readonly id?: () => string;
  /** Stops a run that never settles. */
  readonly maxTicks?: number;
  /**
   * Answers work that is waiting for a person. Without it a gated task simply
   * waits, which is the honest headless behaviour: nobody is at the desk.
   */
  readonly decide?: GateDecider;
  /**
   * How this run reaches the web. Injected so a test is offline and a rehearsal
   * can answer without a network, exactly as the provider is.
   */
  readonly fetch?: WebFetch;
}

/** What a person is being asked to decide, and what they decided. */
export interface GateRequest {
  readonly task: Task;
  /** The categories this task involves that the department gates. */
  readonly gates: readonly GatedAction[];
  /**
   * The one call being held, when this is a run stopped before a tool rather
   * than finished work waiting for a sign-off. Absent for a review gate.
   */
  readonly call?: HeldCall;
}

export interface GateDecision {
  readonly decision: "approved" | "rejected";
  /** A person, not an employee: no agent may decide in the owner's place. */
  readonly decidedBy: string;
  readonly reason?: string;
}

/** Answers a waiting gate, or null to leave the work waiting. */
export type GateDecider = (request: GateRequest) => GateDecision | null;

/** Something the office wrote, with what is actually in it. */
export interface ProducedDocument {
  readonly document: Document;
  readonly text: string;
}

export interface OfficeRunResult {
  readonly ticks: number;
  readonly tasks: readonly Task[];
  /**
   * What the day produced. Held in memory like the tasks are: a headless run is
   * meant to be reproducible from an office file and a brief, and persisting
   * what it wrote is the server's job.
   */
  readonly documents: readonly ProducedDocument[];
  readonly usage: readonly UsageEvent[];
  readonly effects: readonly WorkflowEffect[];
  /** Handoffs the office could not place, said out loud rather than dropped. */
  readonly handoffProblems: readonly string[];
  readonly done: number;
}

export const DEFAULT_MAX_TICKS = 50;

/**
 * The statuses a run in flight can be in: being done, or waiting for a person.
 * Anything else means the attempt is over and its checkpoint is spent.
 */
const ATTEMPT_STATUSES: readonly string[] = ["in_progress", "blocked"];

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
  const handoffProblems: string[] = [];
  let handedOn = 0;
  const nextTaskId = options.id ?? (() => `task-handoff-${String(++handedOn)}`);
  const decoder = new TextDecoder();
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

  /** The receiving department's people, for a handoff to choose between. */
  const candidatesIn = (departmentId: string): PeerCandidate[] => {
    const load = openTaskCounts([...tasks.values()]);
    return config.employees
      .filter((employee) => employee.departmentId === departmentId)
      .map((employee) => ({
        id: employee.id,
        departmentId: employee.departmentId,
        status: employee.status,
        skillIds: employee.skillIds,
        openTasks: load[employee.id] ?? 0,
      }));
  };

  const contextFor = (
    task: Task,
    employeeId: EmployeeId | null,
    documents: readonly DocumentId[] = [],
  ): WorkflowContext => {
    const department = departments.get(task.departmentId);
    const employee = employeeId === null ? undefined : employees.get(employeeId);
    const assignee = task.assigneeId === null ? undefined : employees.get(task.assigneeId);
    // Recomputed per call rather than kept: tasks move throughout a run, and a
    // stale count would send work to somebody who has since filled up.
    const load = openTaskCounts([...tasks.values()]);
    const everyone = config.employees.map((e) => ({
      id: e.id,
      departmentId: e.departmentId,
      status: e.status,
      skillIds: e.skillIds,
      openTasks: load[e.id] ?? 0,
    }));
    return {
      policy: department?.reviewPolicy ?? { kind: "direct" },
      documents,
      acceptanceCriteria: acceptanceCriteriaFor(
        task.acceptanceCriteria,
        department?.definitionOfDone ?? [],
      ),
      now: now(),
      supervisorId: assignee?.supervisorId ?? employee?.supervisorId ?? null,
      peers: everyone.filter((e) => e.departmentId === task.departmentId),
      // The whole office, for the one thing that looks outside this task's own
      // department: another department whose arrow says it checks this work.
      colleagues: everyone,
      escalationGraph,
    };
  };

  const dispatch = async (
    task: Task,
    event: WorkflowEvent,
    actor: EmployeeId | null,
  ): Promise<Task> => {
    // What this work produced, so the engine can say what travels with it.
    const produced = await listTray(store.documents, { kind: "task", id: task.id }, "out");
    const outcome = engine.handle(
      task,
      event,
      contextFor(
        task,
        actor,
        produced.map((document) => document.id),
      ),
    );
    if (!outcome.ok) {
      // A refused transition is the engine telling us the office is not in the
      // state we thought; leave the task alone and let the next tick decide.
      return task;
    }
    effects.push(...outcome.value.effects);
    tasks.set(outcome.value.task.id, outcome.value.task);

    // A checkpoint belongs to the attempt that is running. The moment the work
    // moves on, what it wrote down is spent — and the next turn on this task
    // reading it would find a finished run and hand back its answer instead of
    // doing the work. The office applies the same rule on its own transitions.
    if (!ATTEMPT_STATUSES.includes(outcome.value.task.status)) {
      await checkpoints.delete(outcome.value.task.id);
      decisions.delete(outcome.value.task.id);
    }

    // Work crossing into another department is the one effect this run carries
    // out rather than merely recording: without it a finished task is the end
    // of the line, however the departments are wired.
    for (const effect of outcome.value.effects) {
      if (effect.type !== "create_work") continue;
      const placed = performCreateWork(
        effect,
        config.office.id,
        candidatesIn(effect.toDepartmentId),
        {
          id: () => nextTaskId() as TaskId,
          now,
        },
      );
      if (isErr(placed)) {
        // Refused means the office would not hold it; say so rather than
        // dropping work on the floor.
        handoffProblems.push(
          `could not hand "${effect.title}" to ${effect.toDepartmentId}: ` +
            placed.error.map((error) => `${error.path}: ${error.message}`).join("; "),
        );
        continue;
      }
      // Usually one piece of work; a shootout bench makes one per entrant, and
      // each needs its own copy of what arrived.
      for (const one of placed.value) {
        tasks.set(one.task.id, one.task);

        // Copies naming one body, so the department that made it still holds it.
        await copyIntoTray(
          store.documents,
          effect.documents,
          { kind: "task", id: one.task.id },
          "in",
          { id: documentId, now },
        );
      }
    }
    return outcome.value.task;
  };

  /**
   * The same turn the worker takes, so `vo run` and a deployed worker cannot
   * end up with two different ideas of what an employee does when its name
   * comes up. Metering is wrapped in here because attribution is per turn.
   */
  // Trays for the day, thrown away with the run. The real service rather than a
  // fourth hand-rolled one, so filing here and filing at the office agree about
  // keys, sizes and what a refusal looks like.
  const store = new InMemoryRelationalStore();
  const trays = { documents: store.documents, blobs: new InMemoryBlobStore() };
  let writtenCount = 0;
  const documentId = () => `doc-${String(++writtenCount)}` as DocumentId;

  const documentSink: DocumentSink = {
    file: async (request) =>
      fileDocument(
        trays,
        {
          officeId: request.officeId,
          owner: { kind: "task", id: request.taskId },
          tray: request.tray,
          name: request.name,
          mediaType: request.mediaType,
          body: new TextEncoder().encode(request.content),
          addedBy: request.actorId,
        },
        { id: documentId, now },
      ).then((filed) =>
        isErr(filed)
          ? filed
          : { ok: true as const, value: { id: filed.value.id, name: filed.value.name } },
      ),
  };

  // What this office can reach, built once: it holds the HTTP client.
  const broker = officeBroker(
    config.connectors,
    options.fetch === undefined ? {} : { fetch: options.fetch },
  );
  const describedTools = await broker.describe();

  /**
   * Where a run that stopped for a person is kept.
   *
   * In memory, because a headless run is one process from start to finish: the
   * office keeps these in blobs so another worker can take a run on, and here
   * there is no other worker. It is still needed — resuming answers the held
   * call out of the checkpoint rather than asking the model again.
   */
  const checkpoints = new InMemoryRunCheckpointStore();
  /** What the owner decided, per task, for the turn that resumes. */
  const decisions = new Map<string, ApprovalDecision[]>();

  const turn = llmAgentTurn({
    provider: options.provider,
    wrapProvider: (provider, attribution) => meterProvider(provider, { recorder, attribution }),
    documents: documentSink,
    tools: broker,
    checkpoints,
  });

  /**
   * What one employee may call: the office's connectors, narrowed by the grants
   * on its department and on itself. Resolved here because it needs the office,
   * which the turn deliberately does not have.
   */
  const toolsFor = (employee: Employee) => {
    const department = departments.get(employee.departmentId);
    return {
      grants: [...(department?.toolGrants ?? []), ...employee.toolGrants],
      catalog: catalogFor(
        {
          connectors: config.connectors,
          departmentGrants: department?.toolGrants ?? [],
          employeeGrants: employee.toolGrants,
        },
        describedTools,
      ),
    };
  };

  /** What this work was handed, as text a prompt can carry. */
  const handedOver = async (task: Task): Promise<readonly HandedOver[]> => {
    const held = await listTray(store.documents, { kind: "task", id: task.id }, "in");
    const read = await Promise.all(held.map((one) => readDocument(trays, one.id)));
    return read.flatMap((found) =>
      found === null ? [] : [{ name: found.document.name, text: decoder.decode(found.body) }],
    );
  };

  const handle = async (job: Job): Promise<void> => {
    if (job.kind !== AGENT_RUN_JOB && job.kind !== AGENT_REVIEW_JOB) return;

    const taskId = job.payload["taskId"] as TaskId | undefined;
    const task = taskId === undefined ? undefined : tasks.get(taskId);
    if (task === undefined || job.employeeId === null) return;
    const actor = employees.get(job.employeeId);
    if (actor === undefined) return;

    let current = task;
    const criteria = acceptanceCriteriaFor(
      current.acceptanceCriteria,
      departments.get(current.departmentId)?.definitionOfDone ?? [],
    );
    const reachable = toolsFor(actor);
    for (const event of await turn({
      task: current,
      actor,
      kind: job.kind,
      acceptanceCriteria: criteria,
      documents: await handedOver(current),
      toolCatalog: reachable.catalog,
      connectors: config.connectors,
      toolGrants: reachable.grants,
      approvals: decisions.get(current.id) ?? [],
    })) {
      // Each event is applied to where the last one left the task; a refused
      // one leaves it untouched and the next is judged against that.
      current = await dispatch(current, event, job.employeeId);
    }
  };

  /**
   * The same view the worker schedules from. Built by the shared helper rather
   * than by hand here: two builders of the same thing drift, and the one that
   * drifts is always the one nobody is watching.
   */
  const snapshot = (): SchedulerSnapshot =>
    officeSnapshot({
      office: config.office,
      departments: config.departments,
      employees: config.employees,
      tasks: [...tasks.values()],
    });

  /** What this task is waiting on a person for; empty when it is not waiting. */
  const waitingOn = (task: Task): readonly GatedAction[] => {
    if (task.status !== "in_review") return [];
    const policy = departments.get(task.departmentId)?.reviewPolicy;
    // The office's own rule, not a second copy of it: what a department holds
    // has to mean the same thing here, in the engine, and in the inbox.
    return policy === undefined ? [] : gatesAwaiting(task, policy);
  };

  /**
   * The calls a parked run is holding, read from where it stopped.
   *
   * A blocked task is not enough to go on: the gate holds particular calls with
   * particular arguments, and that is what a person is answering.
   */
  const heldBy = async (task: Task): Promise<readonly HeldCall[]> => {
    if (task.status !== "blocked") return [];
    const kept = await checkpoints.load(task.id);
    return kept?.pendingApproval?.items ?? [];
  };

  /** Puts every waiting task to the owner. True when any of them was answered. */
  const answerGates = async (): Promise<boolean> => {
    const decide = options.decide;
    if (decide === undefined) return false;
    let answered = false;

    // Runs stopped before a call that acts. Asked one call at a time, because
    // approving "this task may send email" in advance is not a gate.
    for (const task of [...tasks.values()]) {
      for (const call of await heldBy(task)) {
        const decision = decide({ task, gates: call.gates, call });
        if (decision === null) continue;
        const made: ApprovalDecision = {
          key: call.key,
          decision: decision.decision === "approved" ? "approved" : "declined",
          decidedBy: decision.decidedBy,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        };
        decisions.set(task.id, [
          ...(decisions.get(task.id) ?? []).filter((one) => one.key !== made.key),
          made,
        ]);
        await dispatch(
          task,
          {
            type: "call_decided",
            key: made.key,
            decision: made.decision,
            decidedBy: made.decidedBy,
            ...(made.reason === undefined ? {} : { reason: made.reason }),
          },
          null,
        );
        answered = true;
      }
    }

    for (const task of [...tasks.values()]) {
      const gates = waitingOn(task);
      if (gates.length === 0) continue;
      const decision = decide({ task, gates });
      if (decision === null) continue;
      await dispatch(
        task,
        {
          type: "gate_decided",
          decision: decision.decision,
          decidedBy: decision.decidedBy,
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        },
        null,
      );
      answered = true;
    }
    return answered;
  };

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
    const quiet = report.enqueued === 0 && report.processed === 0 && pending.pending === 0;
    // Quiet may only mean the office is waiting on a person. Ask, and carry on
    // if somebody answered; an unanswered gate ends the run rather than spins.
    if (quiet && !(await answerGates())) break;
  }

  // A connector can be a process, and a run that leaves one behind leaves one
  // behind per run — which is how somebody running `vo run` in a loop finds out.
  await broker.close();

  const finished = [...tasks.values()];
  const rows = await store.documents.list({ orderBy: { field: "id", direction: "asc" } });
  const produced = await Promise.all(rows.items.map((row) => readDocument(trays, row.id)));

  return {
    ticks,
    tasks: finished,
    documents: produced.flatMap((found) =>
      found === null ? [] : [{ document: found.document, text: decoder.decode(found.body) }],
    ),
    usage: sink instanceof InMemoryUsageSink ? sink.events : [],
    effects,
    handoffProblems,
    done: finished.filter((task) => task.status === "done").length,
  };
}

/** Exported for the command layer and for tests that build their own task. */
export { transitionTask };

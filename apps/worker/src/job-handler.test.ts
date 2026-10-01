import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "@vo/api-client";
import type { EmployeeId } from "@vo/core";
import {
  AGENT_JUDGE_JOB,
  AGENT_RUN_JOB,
  AGENT_REVIEW_JOB,
  type AgentTurn,
  type Job,
  type JudgeTurn,
} from "@vo/orchestrator";
import { officeJobHandler } from "./job-handler.js";

const at = new Date("2026-09-28T09:00:00Z");

const task = {
  id: "task-1",
  officeId: "office-1",
  departmentId: "dept-eng",
  assigneeId: "emp-ada",
  title: "Write the parser",
  status: "assigned",
  priority: "normal",
  reviewerIds: ["emp-grace"],
  // As the client returns it: the wire fills these in even when an older
  // office omits them, so a double that leaves them out is not a real answer.
  acceptanceCriteria: [],
  history: [{ type: "created", at }],
};
const ada = {
  id: "emp-ada",
  name: "Ada",
  role: "Engineer",
  officeId: "office-1",
  departmentId: "dept-eng",
  llm: { provider: "anthropic", model: "claude-sonnet-5" },
  toolGrants: [],
};

function api(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    loadOffice: () => Promise.reject(new Error("not used here")),
    getOffice: () => Promise.reject(new Error("not used here")),
    getDepartment: () =>
      Promise.resolve({ ok: true, value: { definitionOfDone: [], toolGrants: [] } as never }),
    getEmployee: () => Promise.resolve({ ok: true, value: ada as never }),
    getTask: () => Promise.resolve({ ok: true, value: task as never }),
    patchOffice: () => Promise.reject(new Error("not used here")),
    patchConnection: () => Promise.reject(new Error("not used here")),
    patchDepartment: () => Promise.reject(new Error("not used here")),
    patchEmployee: () => Promise.reject(new Error("not used here")),
    getDocument: () => Promise.reject(new Error("not used here")),
    listConnectors: () => Promise.resolve({ ok: true, value: [] }),
    createConnector: () => Promise.reject(new Error("not used here")),
    patchConnector: () => Promise.reject(new Error("not used here")),
    deleteConnector: () => Promise.reject(new Error("not used here")),
    setOfficeRunState: () => Promise.reject(new Error("not used here")),
    setDepartmentRunState: () => Promise.reject(new Error("not used here")),
    setEmployeeStatus: () => Promise.reject(new Error("not used here")),
    recordUsage: () => Promise.reject(new Error("not used here")),
    listUsage: () => Promise.reject(new Error("not used here")),
    officeSpend: () => Promise.reject(new Error("not used here")),
    // Every turn asks what is in its in-tray, so this one is always used.
    listDocuments: () => Promise.resolve({ ok: true, value: [] }),
    uploadDocument: () => Promise.reject(new Error("not used here")),
    downloadDocument: () => Promise.reject(new Error("not used here")),
    deleteDocument: () => Promise.reject(new Error("not used here")),
    postTaskEvent: () => Promise.resolve({ ok: true, value: task as never }),
    recordContestWin: () => Promise.reject(new Error("not used here")),
    signIn: () => Promise.reject(new Error("not used here")),
    signOut: () => Promise.reject(new Error("not used here")),
    listOffices: () => Promise.reject(new Error("not used here")),
    createOffice: () => Promise.reject(new Error("not used here")),
    ...overrides,
  };
}

const job = (overrides: Partial<Job> = {}): Job =>
  ({
    id: "job-1",
    officeId: "office-1",
    employeeId: "emp-ada",
    kind: AGENT_RUN_JOB,
    payload: { taskId: "task-1", departmentId: "dept-eng" },
    priority: 0,
    idempotencyKey: null,
    attempts: 1,
    maxAttempts: 3,
    runAt: 0,
    enqueuedAt: 0,
    ...overrides,
  }) as Job;

/** An agent that always decides the same thing, without asking a model. */
const decides =
  (...events: Record<string, unknown>[]): AgentTurn =>
  () =>
    Promise.resolve(events as never);

describe("doing a piece of an office's work", () => {
  it("tells the office what the agent decided", async () => {
    const postTaskEvent = vi.fn(() => Promise.resolve({ ok: true as const, value: task as never }));
    await officeJobHandler({
      api: api({ postTaskEvent }),
      agent: decides({ type: "submit", actorId: "emp-ada" }),
    })(job());

    expect(postTaskEvent).toHaveBeenCalledWith("task-1", { type: "submit", actorId: "emp-ada" });
  });

  it("reports a turn's events in the order they happened", async () => {
    const posted: unknown[] = [];
    const postTaskEvent = vi.fn((_id: string, event: unknown) => {
      posted.push(event);
      return Promise.resolve({ ok: true as const, value: task as never });
    });
    await officeJobHandler({
      api: api({ postTaskEvent }),
      agent: decides({ type: "start", actorId: "emp-ada" }, { type: "submit", actorId: "emp-ada" }),
    })(job());

    expect(posted.map((event) => (event as { type: string }).type)).toEqual(["start", "submit"]);
  });

  it("gives the agent the task and the person the job names, read from the office", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const getTask = vi.fn(() => Promise.resolve({ ok: true as const, value: task as never }));
    const getEmployee = vi.fn(() => Promise.resolve({ ok: true as const, value: ada as never }));
    await officeJobHandler({ api: api({ getTask, getEmployee }), agent })(job());

    expect(getTask).toHaveBeenCalledWith("task-1");
    expect(getEmployee).toHaveBeenCalledWith("emp-ada");
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({
        task,
        actor: ada,
        kind: AGENT_RUN_JOB,
        acceptanceCriteria: [],
        documents: [],
      }),
    );
  });

  it("gives the agent what is in the work's in-tray, as text it can read", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const listDocuments = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: [
          { id: "doc-1", name: "the-brief.md", mediaType: "text/markdown" },
          // Nothing to show a model: left out rather than described.
          { id: "doc-2", name: "logo.png", mediaType: "image/png" },
        ] as never,
      }),
    );
    const downloadDocument = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: new TextEncoder().encode("Make it obvious.") }),
    );

    await officeJobHandler({ api: api({ listDocuments, downloadDocument }), agent })(job());

    expect(listDocuments).toHaveBeenCalledWith("office-1", {
      ownerKind: "task",
      ownerId: "task-1",
      tray: "in",
    });
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({ documents: [{ name: "the-brief.md", text: "Make it obvious." }] }),
    );
  });

  it("works on without an in-tray it cannot read, rather than stopping", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const listDocuments = vi.fn(() =>
      Promise.resolve({ ok: false as const, kind: "transport" as const, message: "no trays" }),
    );

    await officeJobHandler({ api: api({ listDocuments }), agent })(job());
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ documents: [] }));
  });

  it("tells the agent it is reviewing, not working, when that is the job", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    await officeJobHandler({ api: api(), agent })(
      job({ kind: AGENT_REVIEW_JOB, employeeId: "emp-grace" as never }),
    );
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ kind: AGENT_REVIEW_JOB }));
  });

  it("says nothing to the office when the agent had nothing to report", async () => {
    const postTaskEvent = vi.fn(() => Promise.resolve({ ok: true as const, value: task as never }));
    await officeJobHandler({ api: api({ postTaskEvent }), agent: decides() })(job());
    expect(postTaskEvent).not.toHaveBeenCalled();
  });

  it("stops after an event the office would not take, rather than reporting what follows from it", async () => {
    // A submit that was refused means the task never moved; anything the turn
    // decided afterwards was decided about a task in a state it is not in.
    const posted: unknown[] = [];
    const postTaskEvent = vi.fn((_id: string, event: unknown) => {
      posted.push(event);
      return Promise.resolve({
        ok: false as const,
        kind: "validation" as const,
        errors: [{ path: "type", message: "a task in done cannot be started" }],
      });
    });
    await officeJobHandler({
      api: api({ postTaskEvent }),
      agent: decides({ type: "start", actorId: "emp-ada" }, { type: "submit", actorId: "emp-ada" }),
      onProblem: () => undefined,
    })(job());

    expect(posted).toHaveLength(1);
  });

  it("lets a job whose office it could not reach come round again", async () => {
    const handle = officeJobHandler({
      api: api({
        getTask: () => Promise.resolve({ ok: false, kind: "transport", message: "refused" }),
      }),
      agent: decides({ type: "submit", actorId: "emp-ada" }),
    });
    await expect(handle(job())).rejects.toThrow(/refused/);
  });

  it("lets a report the office could not take come round again", async () => {
    const handle = officeJobHandler({
      api: api({
        postTaskEvent: () =>
          Promise.resolve({ ok: false, kind: "transport", message: "connection reset" }),
      }),
      agent: decides({ type: "submit", actorId: "emp-ada" }),
    });
    await expect(handle(job())).rejects.toThrow(/connection reset/);
  });

  it("does not keep retrying an event the office refused, since it will refuse it again", async () => {
    const problems: string[] = [];
    const handle = officeJobHandler({
      api: api({
        postTaskEvent: () =>
          Promise.resolve({
            ok: false,
            kind: "validation",
            errors: [{ path: "type", message: "a task in done cannot be submitted" }],
          }),
      }),
      agent: decides({ type: "submit", actorId: "emp-ada" }),
      onProblem: (message) => problems.push(message),
    });

    await expect(handle(job())).resolves.toBeUndefined();
    expect(problems[0]).toMatch(/cannot be submitted/);
  });

  it("refuses a job that names no task rather than guessing which one", async () => {
    const handle = officeJobHandler({ api: api(), agent: decides() });
    await expect(handle(job({ payload: {} }))).rejects.toThrow(/taskId/);
  });

  it("refuses a job with nobody to do it rather than acting as a nameless employee", async () => {
    const handle = officeJobHandler({ api: api(), agent: decides() });
    await expect(handle(job({ employeeId: null }))).rejects.toThrow(/employee/i);
  });

  it("leaves a job it was not built for alone, and says it saw it", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const problems: string[] = [];
    await officeJobHandler({ api: api(), agent, onProblem: (m) => problems.push(m) })(
      job({ kind: "nightly_report" }),
    );
    expect(agent).not.toHaveBeenCalled();
    expect(problems[0]).toMatch(/nightly_report/);
  });
});

describe("telling the agent what done means", () => {
  it("asks the office what this department expects, and passes it on", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const getDepartment = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { id: "dept-eng", definitionOfDone: ["has tests"], toolGrants: [] } as never,
      }),
    );
    await officeJobHandler({ api: api({ getDepartment }), agent })(job());

    expect(getDepartment).toHaveBeenCalledWith("dept-eng");
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({ acceptanceCriteria: ["has tests"] }),
    );
  });

  it("prefers what the task itself asks for", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const getTask = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { ...task, acceptanceCriteria: ["migrates the old rows"] } as never,
      }),
    );
    const getDepartment = vi.fn(() =>
      Promise.resolve({
        ok: true as const,
        value: { definitionOfDone: ["has tests"], toolGrants: [] } as never,
      }),
    );
    await officeJobHandler({ api: api({ getTask, getDepartment }), agent })(job());

    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({ acceptanceCriteria: ["migrates the old rows"] }),
    );
  });

  it("carries on with nothing when the department cannot be read", async () => {
    // A department the office cannot answer about is not a reason to stop
    // working; it is a reason to have no list.
    const agent = vi.fn(() => Promise.resolve([]));
    const getDepartment = () =>
      Promise.resolve({ ok: false as const, kind: "transport" as const, message: "unreachable" });
    await officeJobHandler({ api: api({ getDepartment }), agent })(job());

    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ acceptanceCriteria: [] }));
  });
});

describe("what a worker's employee may reach", () => {
  const webConnector = {
    id: "conn-web",
    officeId: "office-1",
    kind: "web",
    name: "design-web",
    config: { hosts: ["help.figma.com"] },
    secretRef: null,
    tools: ["fetch_url"],
    enabled: true,
    createdAt: new Date("2026-09-30T09:00:00Z"),
  };

  it("asks the office what it can reach", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const listConnectors = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: [webConnector] as never }),
    );

    await officeJobHandler({ api: api({ listConnectors }), agent })(job());
    expect(listConnectors).toHaveBeenCalledWith("office-1");
  });

  it("offers the employee only what its room and it were granted", async () => {
    const agent = vi.fn(() => Promise.resolve([]));
    const granted = { ...task, departmentId: "dept-eng" };
    const api2 = api({
      listConnectors: () => Promise.resolve({ ok: true as const, value: [webConnector] as never }),
      getDepartment: () =>
        Promise.resolve({
          ok: true as const,
          value: {
            id: "dept-eng",
            definitionOfDone: [],
            toolGrants: [{ connectorId: "conn-web", tool: "fetch_url" }],
          } as never,
        }),
      getTask: () => Promise.resolve({ ok: true as const, value: granted as never }),
    });

    await officeJobHandler({ api: api2, agent })(job());
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({
        toolGrants: [{ connectorId: "conn-web", tool: "fetch_url" }],
      }),
    );
  });

  it("works on with nothing to reach when the office cannot say", async () => {
    // An office running a version without connectors is an office with no
    // tools, not a job that fails.
    const agent = vi.fn(() => Promise.resolve([]));
    const api2 = api({
      listConnectors: () =>
        Promise.resolve({ ok: false as const, kind: "transport" as const, message: "no route" }),
    });

    await officeJobHandler({ api: api2, agent })(job());
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ connectors: [] }));
  });
});

describe("deciding a shootout", () => {
  const entry = (id: string, assigneeId: string) => ({
    id,
    officeId: "office-1",
    departmentId: "dept-eng",
    assigneeId,
    title: "Draft the launch note",
    status: "done",
    priority: "normal",
    benchId: "bench-draft",
    contestId: "contest-1",
    won: null,
    reviewerIds: [],
    acceptanceCriteria: ["It fits on one screen"],
    history: [{ type: "created", at }],
  });

  const theo = { ...ada, id: "emp-theo", name: "Theo" };
  const grace = { ...ada, id: "emp-grace", name: "Grace" };

  const snapshot = {
    office: { id: "office-1", name: "Acme" },
    departments: [{ id: "dept-eng", definitionOfDone: [], toolGrants: [], benches: [] }],
    employees: [ada, theo, grace],
    tasks: [entry("task-a", "emp-ada"), entry("task-b", "emp-theo"), ordinary()],
    connections: [],
    connectors: [],
  };

  /** Work in the same office that belongs to no contest. */
  function ordinary() {
    return { ...entry("task-x", "emp-ada"), contestId: null, title: "Something else" };
  }

  const judging = (overrides: Partial<Job> = {}): Job =>
    job({
      kind: AGENT_JUDGE_JOB,
      employeeId: "emp-grace" as EmployeeId,
      payload: { contestId: "contest-1", departmentId: "dept-eng" },
      ...overrides,
    });

  const judgingApi = (overrides: Partial<ApiClient> = {}): ApiClient =>
    api({
      loadOffice: () => Promise.resolve({ ok: true, value: snapshot as never }),
      getEmployee: () => Promise.resolve({ ok: true, value: grace as never }),
      listDocuments: (_officeId: string, filter?: { ownerId?: string }) =>
        Promise.resolve({
          ok: true,
          value: [
            {
              id: `doc-${filter?.ownerId ?? "?"}`,
              name: `${filter?.ownerId ?? "?"}.md`,
              mediaType: "text/markdown",
              ownerKind: "task",
              ownerId: filter?.ownerId ?? "",
              tray: "out",
            },
          ] as never,
        }),
      downloadDocument: (id: string) =>
        Promise.resolve({ ok: true, value: new TextEncoder().encode(`the answer in ${id}`) }),
      ...overrides,
    });

  /** A judge that always picks the entry it is told to. */
  const picks =
    (taskId: string, reason = "clearer"): JudgeTurn =>
    () =>
      Promise.resolve({ winnerTaskId: taskId as never, reason });

  it("tells the office which entry won, and why", async () => {
    const recordContestWin = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: task as never }),
    );
    await officeJobHandler({
      api: judgingApi({ recordContestWin }),
      agent: decides(),
      judge: picks("task-b"),
    })(judging());

    expect(recordContestWin).toHaveBeenCalledWith("task-b", {
      reason: "clearer",
      decidedBy: "emp-grace",
    });
  });

  it("shows the judge every entry in that contest, and nothing else", async () => {
    let seen: readonly { readonly taskId: string }[] = [];
    const judge: JudgeTurn = (request) => {
      seen = request.entries;
      return Promise.resolve(null);
    };
    await officeJobHandler({ api: judgingApi(), agent: decides(), judge })(judging());

    expect(seen.map((one) => one.taskId)).toEqual(["task-a", "task-b"]);
  });

  it("shows the judge what each entry produced", async () => {
    let seen: readonly { readonly outputs: readonly { readonly text: string }[] }[] = [];
    const judge: JudgeTurn = (request) => {
      seen = request.entries;
      return Promise.resolve(null);
    };
    await officeJobHandler({ api: judgingApi(), agent: decides(), judge })(judging());

    expect(seen[0]?.outputs[0]?.text).toContain("the answer in doc-task-a");
  });

  it("tells the judge what was asked and what counted as done", async () => {
    let asked = { question: "", criteria: [] as readonly string[] };
    const judge: JudgeTurn = (request) => {
      asked = { question: request.question, criteria: request.criteria };
      return Promise.resolve(null);
    };
    await officeJobHandler({ api: judgingApi(), agent: decides(), judge })(judging());

    expect(asked.question).toBe("Draft the launch note");
    expect(asked.criteria).toEqual(["It fits on one screen"]);
  });

  it("records nothing when the judge decided nothing", async () => {
    // A model that did not answer clearly has not decided, and a person still can.
    const recordContestWin = vi.fn(() =>
      Promise.resolve({ ok: true as const, value: task as never }),
    );
    const said: string[] = [];
    await officeJobHandler({
      api: judgingApi({ recordContestWin }),
      agent: decides(),
      judge: () => Promise.resolve(null),
      onProblem: (message) => said.push(message),
    })(judging());

    expect(recordContestWin).not.toHaveBeenCalled();
    expect(said.join(" ")).toMatch(/contest-1/);
  });

  it("reports a verdict the office refused rather than trying forever", async () => {
    // "Already decided", because a person got there first. Coming back would be
    // refused identically every time.
    const said: string[] = [];
    await officeJobHandler({
      api: judgingApi({
        recordContestWin: () =>
          Promise.resolve({
            ok: false,
            kind: "validation",
            errors: [{ path: "contest", message: "already decided" }],
          }),
      }),
      agent: decides(),
      judge: picks("task-b"),
      onProblem: (message) => said.push(message),
    })(judging());

    expect(said.join(" ")).toMatch(/already decided/);
  });

  it("throws when the office could not be reached, so the queue comes back", async () => {
    await expect(
      officeJobHandler({
        api: judgingApi({
          recordContestWin: () =>
            Promise.resolve({ ok: false, kind: "transport", message: "unreachable" }),
        }),
        agent: decides(),
        judge: picks("task-b"),
      })(judging()),
    ).rejects.toThrow(/unreachable/);
  });

  it("throws when the contest has no entries, which should not happen", async () => {
    await expect(
      officeJobHandler({ api: judgingApi(), agent: decides(), judge: picks("task-b") })(
        judging({ payload: { contestId: "contest-nowhere", departmentId: "dept-eng" } }),
      ),
    ).rejects.toThrow(/contest-nowhere/);
  });

  it("leaves a judging job alone when this worker has no judge to do it with", async () => {
    const said: string[] = [];
    await officeJobHandler({
      api: judgingApi(),
      agent: decides(),
      onProblem: (message) => said.push(message),
    })(judging());

    expect(said.join(" ")).toMatch(/judge/i);
  });
});

import { describe, expect, it } from "vitest";
import {
  createTask,
  isErr,
  isOk,
  unwrap,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type Connection,
  type ConnectionId,
  type ReviewPolicy,
  type Task,
  type TaskId,
  type TaskStatus,
} from "@vo/core";
import {
  defaultWorkflowEngine,
  DIRECT_POLICY_HANDLER,
  WorkflowEngine,
  type WorkflowContext,
  type WorkflowEffect,
  type WorkflowEvent,
} from "./workflow-engine.js";

const officeId = "office-1" as OfficeId;
const departmentId = "dept-eng" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const boss = "emp-boss" as EmployeeId;
const t0 = new Date("2026-09-27T09:00:00Z");
const t1 = new Date("2026-09-27T10:00:00Z");

function task(status: TaskStatus = "assigned", overrides: Partial<Task> = {}): Task {
  const created = unwrap(
    createTask(
      { officeId, departmentId, title: "Write the parser", assigneeId: ada },
      { id: () => "task-1" as TaskId, now: () => t0 },
    ),
  );
  return { ...created, status, ...overrides };
}

const direct: ReviewPolicy = { kind: "direct" };
const context = (
  policy: ReviewPolicy = direct,
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({
  policy,
  now: t1,
  supervisorId: boss,
  ...overrides,
});

const engine = defaultWorkflowEngine();

describe("WorkflowEngine: policy-independent events", () => {
  it("start moves an assigned task into progress", () => {
    const outcome = unwrap(
      engine.handle(task("assigned"), { type: "start", actorId: ada }, context()),
    );
    expect(outcome.task.status).toBe("in_progress");
    expect(outcome.effects).toEqual([]);
    expect(outcome.task.history.at(-1)).toMatchObject({
      from: "assigned",
      to: "in_progress",
      actorId: ada,
      at: t1,
    });
  });

  it("block records the reason and tells the supervisor", () => {
    const outcome = unwrap(
      engine.handle(
        task("in_progress"),
        { type: "block", reason: "waiting on the staging database", actorId: ada },
        context(),
      ),
    );
    expect(outcome.task.status).toBe("blocked");
    expect(outcome.task.history.at(-1)?.reason).toBe("waiting on the staging database");
    expect(outcome.effects).toEqual([
      {
        type: "notify",
        audience: "supervisor",
        message: expect.stringContaining("waiting on the staging database") as string,
      },
    ]);
  });

  it("unblock returns the task to its assignee", () => {
    const outcome = unwrap(
      engine.handle(task("blocked"), { type: "unblock", actorId: boss }, context()),
    );
    expect(outcome.task.status).toBe("in_progress");
  });

  it("refuses to unblock a task with no assignee", () => {
    const result = engine.handle(
      task("blocked", { assigneeId: null }),
      { type: "unblock" },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/assignee/);
  });

  it("cancel ends the task from any live status and records the reason", () => {
    for (const status of ["backlog", "assigned", "in_progress", "in_review", "blocked"] as const) {
      const outcome = unwrap(
        engine.handle(
          task(status),
          { type: "cancel", reason: "superseded", actorId: boss },
          context(),
        ),
      );
      expect(outcome.task.status, status).toBe("cancelled");
      expect(outcome.task.history.at(-1)?.reason).toBe("superseded");
    }
  });

  it("rejects any event on a terminal task", () => {
    for (const status of ["done", "cancelled"] as const) {
      const result = engine.handle(task(status), { type: "cancel", reason: "again" }, context());
      expect(isErr(result), status).toBe(true);
      if (isErr(result)) expect(result.error[0]?.message).toMatch(/final/);
    }
  });

  it("rejects an event that the state machine does not allow from the current status", () => {
    const result = engine.handle(task("backlog"), { type: "start" }, context());
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/backlog/);
  });

  it("never mutates the task it was given", () => {
    const original = task("in_progress");
    const before = structuredClone(original);
    expect(isOk(engine.handle(original, { type: "submit", actorId: ada }, context()))).toBe(true);
    expect(original).toEqual(before);
  });
});

describe("direct policy", () => {
  it("takes submitted work straight to done with no review", () => {
    const outcome = unwrap(
      engine.handle(task("in_progress"), { type: "submit", actorId: ada }, context()),
    );
    expect(outcome.task.status).toBe("done");
    expect(outcome.effects).toEqual([]);
    expect(outcome.task.history.map((h) => h.to)).toEqual(["assigned", "done"]);
  });

  it("records submitted artifacts on the task", () => {
    const outcome = unwrap(
      engine.handle(
        task("in_progress"),
        { type: "submit", actorId: ada, artifacts: ["git://acme/pr/42"] },
        context(),
      ),
    );
    expect(outcome.task.artifacts).toEqual(["git://acme/pr/42"]);
  });

  it("walks the full happy path from assigned to done", () => {
    const started = unwrap(
      engine.handle(task("assigned"), { type: "start", actorId: ada }, context()),
    );
    const finished = unwrap(
      engine.handle(started.task, { type: "submit", actorId: ada }, context()),
    );
    expect(finished.task.status).toBe("done");
    expect(finished.task.history.map((h) => h.to)).toEqual(["assigned", "in_progress", "done"]);
  });

  it("has no review step, so approvals and change requests are rejected", () => {
    for (const event of [
      { type: "approve" as const, actorId: boss },
      { type: "request_changes" as const, actorId: boss, reason: "no" },
    ]) {
      const result = engine.handle(task("in_review"), event, context());
      expect(isErr(result), event.type).toBe(true);
      if (isErr(result)) expect(result.error[0]?.message).toMatch(/direct/);
    }
  });

  it("cannot submit work that was never started", () => {
    const result = engine.handle(task("assigned"), { type: "submit", actorId: ada }, context());
    expect(isErr(result)).toBe(true);
  });
});

describe("policy registry", () => {
  it("fails clearly when no handler is registered for the configured policy", () => {
    const directOnly = new WorkflowEngine([DIRECT_POLICY_HANDLER]);
    const result = directOnly.handle(
      task("in_progress"),
      { type: "submit", actorId: ada },
      context({ kind: "manager", maxIterations: 3 }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]?.path).toBe("policy.kind");
      expect(result.error[0]?.message).toMatch(/manager/);
      expect(result.error[0]?.message).toMatch(/direct/);
    }
  });

  it("accepts additional handlers so each policy can be added on its own", () => {
    const stub = {
      kind: "manager",
      handle: (t: Task, _e: WorkflowEvent, c: WorkflowContext) => ({
        ok: true as const,
        value: {
          task: { ...t, status: "in_review" as TaskStatus },
          effects: [
            {
              type: "notify" as const,
              audience: "supervisor" as const,
              message: `review by ${String(c.supervisorId)}`,
            },
          ],
        },
      }),
    };
    const extended = new WorkflowEngine([DIRECT_POLICY_HANDLER, stub]);
    const outcome = unwrap(
      extended.handle(
        task("in_progress"),
        { type: "submit", actorId: ada },
        context({ kind: "manager", maxIterations: 3 }),
      ),
    );
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.effects[0]).toMatchObject({ audience: "supervisor" });
    expect(extended.policyKinds()).toEqual(["direct", "manager"]);
  });

  it("rejects two handlers for the same policy kind", () => {
    expect(() => new WorkflowEngine([DIRECT_POLICY_HANDLER, DIRECT_POLICY_HANDLER])).toThrow(
      /duplicate/,
    );
  });
});

describe("finishing here starts work next door", () => {
  const design = "dept-design" as DepartmentId;
  const at = new Date("2026-09-22T00:00:00Z");

  const connection = (
    fromId: DepartmentId,
    toId: DepartmentId,
    kind: Connection["kind"] = "handoff",
    rules: Record<string, unknown> = {},
  ): Connection => ({
    id: `conn-${fromId}-${toId}` as ConnectionId,
    officeId,
    fromId,
    toId,
    kind,
    rules,
    createdAt: at,
  });

  const wired = (connections: readonly Connection[]): WorkflowContext =>
    context(direct, {
      escalationGraph: {
        employees: [{ id: ada, departmentId, supervisorId: boss, status: "active" }],
        connections,
      },
    });

  /** Finishing a task the shortest way there is: a department with no review. */
  const finish = (context: WorkflowContext, overrides: Partial<Task> = {}) =>
    unwrap(
      engine.handle(
        task("in_progress", overrides),
        { type: "submit", actorId: ada, artifacts: ["the parser"] },
        context,
      ),
    );

  const handoffs = (outcome: { effects: readonly WorkflowEffect[] }): readonly WorkflowEffect[] =>
    outcome.effects.filter((effect) => effect.type === "hand_off");

  it("hands the work on when the departments are wired for it", () => {
    const outcome = finish(wired([connection(departmentId, design)]));
    expect(outcome.task.status).toBe("done");
    expect(handoffs(outcome)).toHaveLength(1);
  });

  it("says where the work is going", () => {
    const [effect] = handoffs(finish(wired([connection(departmentId, design)])));
    expect(effect).toMatchObject({ toDepartmentId: design });
  });

  it("hands nothing on when nothing is wired", () => {
    expect(handoffs(finish(wired([])))).toEqual([]);
  });

  it("hands nothing on along an arrow pointing the other way", () => {
    expect(handoffs(finish(wired([connection(design, departmentId)])))).toEqual([]);
  });

  it("hands nothing on along an arrow that is not a handoff", () => {
    const other = connection(departmentId, design, "collaborates");
    expect(handoffs(finish(wired([other])))).toEqual([]);
  });

  it("hands nothing on when the office says nothing about its connections", () => {
    // A caller that supplies no graph gets no handoffs rather than a crash.
    expect(handoffs(finish(context()))).toEqual([]);
  });

  it("hands nothing on for a task that merely moved, rather than finished", () => {
    const outcome = unwrap(
      engine.handle(
        task("assigned"),
        { type: "start", actorId: ada },
        wired([connection(departmentId, design)]),
      ),
    );
    expect(handoffs(outcome)).toEqual([]);
  });

  it("hands the work itself on, not a description of it", () => {
    const [effect] = handoffs(finish(wired([connection(departmentId, design)])));
    expect(effect).toMatchObject({ artifacts: ["the parser"] });
  });

  it("carries a brief naming where the work came from", () => {
    const [effect] = handoffs(finish(wired([connection(departmentId, design)])));
    expect(effect?.type).toBe("hand_off");
    if (effect?.type === "hand_off") expect(effect.brief).toContain("Write the parser");
  });

  it("carries the route it has taken, with this department added", () => {
    const [effect] = handoffs(
      finish(wired([connection(departmentId, design)]), {
        route: ["dept-product" as DepartmentId],
      }),
    );
    expect(effect?.type).toBe("hand_off");
    if (effect?.type === "hand_off") {
      expect(effect.route).toEqual(["dept-product", departmentId]);
    }
  });

  it("carries what the connection said about who should take it", () => {
    const named = connection(departmentId, design, "handoff", { assign: { named: "emp-theo" } });
    const [effect] = handoffs(finish(wired([named])));
    expect(effect).toMatchObject({ assign: { kind: "named", employeeId: "emp-theo" } });
  });

  it("hands on down every arrow leaving the department, not merely the first", () => {
    const ops = "dept-ops" as DepartmentId;
    const outcome = finish(
      wired([connection(departmentId, design), connection(departmentId, ops)]),
    );
    expect(handoffs(outcome)).toHaveLength(2);
  });
});

describe("work going round in circles", () => {
  const design = "dept-design" as DepartmentId;
  const at = new Date("2026-09-22T00:00:00Z");
  const handoff = (fromId: DepartmentId, toId: DepartmentId): Connection => ({
    id: `conn-${fromId}-${toId}` as ConnectionId,
    officeId,
    fromId,
    toId,
    kind: "handoff",
    rules: {},
    createdAt: at,
  });

  const wired = (): WorkflowContext =>
    context(direct, {
      escalationGraph: {
        employees: [{ id: ada, departmentId, supervisorId: boss, status: "active" }],
        connections: [handoff(departmentId, design)],
      },
    });

  const finish = (route: DepartmentId[]) =>
    unwrap(
      engine.handle(
        task("in_progress", { route }),
        { type: "submit", actorId: ada, artifacts: ["again"] },
        wired(),
      ),
    );

  const kinds = (outcome: { effects: readonly WorkflowEffect[] }): string[] =>
    outcome.effects.map((effect) => effect.type);

  it("allows work to come back once, which is ordinary rework", () => {
    expect(kinds(finish([design, departmentId]))).toContain("hand_off");
  });

  it("stops handing on when the work would arrive somewhere for the third time", () => {
    expect(kinds(finish([design, departmentId, design, departmentId]))).not.toContain("hand_off");
  });

  it("escalates instead, so a person decides rather than the office spinning", () => {
    expect(kinds(finish([design, departmentId, design, departmentId]))).toContain("escalate");
  });

  it("says what went round in circles, so the reason is actionable", () => {
    const outcome = finish([design, departmentId, design, departmentId]);
    const escalation = outcome.effects.find((effect) => effect.type === "escalate");
    expect(escalation?.type).toBe("escalate");
    if (escalation?.type === "escalate") expect(escalation.reason).toMatch(/dept-design/);
  });
});

describe("a department with no reviewer still answers the list", () => {
  const criteria = ["handles malformed input", "has tests for the error path"];
  const withCriteria = (): WorkflowContext => context(direct, { acceptanceCriteria: criteria });

  const submit = (met: readonly string[] | undefined, ctx = withCriteria()) =>
    engine.handle(
      task("in_progress"),
      { type: "submit", actorId: ada, ...(met === undefined ? {} : { met }) },
      ctx,
    );

  it("finishes when the submitter met the whole list", () => {
    expect(unwrap(submit(criteria)).task.status).toBe("done");
  });

  it("refuses the submission when something was left out", () => {
    // Otherwise the way round a definition of done is a department with nobody
    // to check it, which is the easiest way round there could be. Refused
    // rather than moved: the work is simply not finished, and there is no state
    // between in progress and done for it to sit in.
    expect(isErr(submit([criteria[0] ?? ""]))).toBe(true);
  });

  it("says what is outstanding rather than refusing blankly", () => {
    const refused = submit([]);
    expect(isErr(refused)).toBe(true);
    if (isErr(refused)) {
      expect(refused.error.map((error) => error.message).join(" ")).toContain(
        "handles malformed input",
      );
    }
  });

  it("finishes as it always did when the office asked for nothing", () => {
    expect(unwrap(submit(undefined, context(direct))).task.status).toBe("done");
  });
});

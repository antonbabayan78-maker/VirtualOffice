import { describe, expect, it } from "vitest";
import {
  createTask,
  isErr,
  unwrap,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type ReviewPolicy,
  type Task,
  type TaskId,
  type TaskStatus,
} from "@vo/core";
import { MANAGER_POLICY_HANDLER, reviewRounds } from "./manager-policy.js";
import {
  defaultWorkflowEngine,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowOutcome,
} from "./workflow-engine.js";

const officeId = "office-1" as OfficeId;
const departmentId = "dept-eng" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const boss = "emp-boss" as EmployeeId;
const t0 = new Date("2026-09-27T09:00:00Z");
let clock = 0;
const nextTime = (): Date => new Date(t0.getTime() + ++clock * 60_000);

function task(status: TaskStatus = "in_progress", overrides: Partial<Task> = {}): Task {
  const created = unwrap(
    createTask(
      { officeId, departmentId, title: "Write the parser", assigneeId: ada },
      { id: () => "task-1" as TaskId, now: () => t0 },
    ),
  );
  return { ...created, status, ...overrides };
}

const manager = (maxIterations = 3): ReviewPolicy => ({ kind: "manager", maxIterations });
const context = (
  policy: ReviewPolicy = manager(),
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({
  policy,
  now: nextTime(),
  supervisorId: boss,
  ...overrides,
});

const engine = defaultWorkflowEngine();
const run = (
  current: Task,
  event: WorkflowEvent,
  policy: ReviewPolicy = manager(),
  overrides: Partial<WorkflowContext> = {},
): WorkflowOutcome => unwrap(engine.handle(current, event, context(policy, overrides)));

describe("manager policy: submit", () => {
  it("sends the work to review and assigns the supervisor as reviewer", () => {
    const outcome = run(task("in_progress"), { type: "submit", actorId: ada });
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.reviewerIds).toEqual([boss]);
    expect(outcome.effects).toEqual([
      {
        type: "notify",
        audience: "supervisor",
        message: expect.stringContaining("Write the parser") as string,
      },
    ]);
  });

  it("falls back to the office owner when the department has no supervisor", () => {
    const outcome = run(task("in_progress"), { type: "submit", actorId: ada }, manager(), {
      supervisorId: null,
    });
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.reviewerIds).toEqual([]);
    expect(outcome.effects[0]).toMatchObject({ audience: "owner" });
  });

  it("refuses a configuration where the supervisor is the assignee", () => {
    const result = engine.handle(
      task("in_progress"),
      { type: "submit", actorId: ada },
      context(manager(), { supervisorId: ada }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/own work/);
  });

  it("records submitted artifacts", () => {
    const outcome = run(task("in_progress"), {
      type: "submit",
      actorId: ada,
      artifacts: ["git://acme/pr/7"],
    });
    expect(outcome.task.artifacts).toEqual(["git://acme/pr/7"]);
  });
});

describe("manager policy: approve", () => {
  it("approves and completes the task, telling the assignee", () => {
    const reviewing = task("in_review", { reviewerIds: [boss] });
    const outcome = run(reviewing, { type: "approve", actorId: boss });
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.history.map((h) => h.to)).toEqual(["assigned", "approved", "done"]);
    expect(outcome.effects[0]).toMatchObject({ audience: "assignee" });
  });

  it("refuses an approval from someone who is not a reviewer", () => {
    const reviewing = task("in_review", { reviewerIds: [boss] });
    const result = engine.handle(reviewing, { type: "approve", actorId: ada }, context());
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/not a reviewer/);
  });

  it("lets the owner approve when there are no named reviewers", () => {
    const reviewing = task("in_review", { reviewerIds: [] });
    expect(
      run(reviewing, { type: "approve", actorId: boss }, manager(), { supervisorId: null }).task
        .status,
    ).toBe("done");
  });

  it("only approves work that is in review", () => {
    for (const status of ["in_progress", "assigned", "changes_requested"] as const) {
      const result = engine.handle(
        task(status, { reviewerIds: [boss] }),
        { type: "approve", actorId: boss },
        context(),
      );
      expect(isErr(result), status).toBe(true);
    }
  });
});

describe("manager policy: changes requested", () => {
  it("sends the work back to the assignee with the reason", () => {
    const reviewing = task("in_review", { reviewerIds: [boss] });
    const outcome = run(reviewing, {
      type: "request_changes",
      actorId: boss,
      reason: "tests are missing",
    });
    expect(outcome.task.status).toBe("in_progress");
    expect(outcome.task.history.map((h) => h.to)).toEqual([
      "assigned",
      "changes_requested",
      "in_progress",
    ]);
    expect(outcome.task.history.find((h) => h.to === "changes_requested")?.reason).toBe(
      "tests are missing",
    );
    expect(outcome.effects[0]).toMatchObject({
      audience: "assignee",
      message: expect.stringContaining("tests are missing") as string,
    });
  });

  it("requires a reason", () => {
    const reviewing = task("in_review", { reviewerIds: [boss] });
    const result = engine.handle(
      reviewing,
      { type: "request_changes", actorId: boss, reason: "   " },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.path).toBe("reason");
  });

  it("refuses a change request from someone who is not a reviewer", () => {
    const reviewing = task("in_review", { reviewerIds: [boss] });
    const result = engine.handle(
      reviewing,
      { type: "request_changes", actorId: ada, reason: "no" },
      context(),
    );
    expect(isErr(result)).toBe(true);
  });
});

describe("reviewRounds", () => {
  it("counts the change requests recorded in history", () => {
    expect(reviewRounds(task("in_progress"))).toBe(0);
    const first = run(task("in_review", { reviewerIds: [boss] }), {
      type: "request_changes",
      actorId: boss,
      reason: "again",
    });
    expect(reviewRounds(first.task)).toBe(1);
    const second = run(run(first.task, { type: "submit", actorId: ada }).task, {
      type: "request_changes",
      actorId: boss,
      reason: "still",
    });
    expect(reviewRounds(second.task)).toBe(2);
  });
});

describe("manager policy: escalation", () => {
  it("escalates the round after the iteration cap instead of looping again", () => {
    const policy = manager(2);
    let current = task("in_review", { reviewerIds: [boss] });

    current = run(
      current,
      { type: "request_changes", actorId: boss, reason: "round 1" },
      policy,
    ).task;
    expect(current.status).toBe("in_progress");
    current = run(current, { type: "submit", actorId: ada }, policy).task;
    current = run(
      current,
      { type: "request_changes", actorId: boss, reason: "round 2" },
      policy,
    ).task;
    expect(current.status).toBe("in_progress");
    expect(reviewRounds(current)).toBe(2);

    current = run(current, { type: "submit", actorId: ada }, policy).task;
    const escalated = run(
      current,
      { type: "request_changes", actorId: boss, reason: "round 3" },
      policy,
    );
    expect(escalated.task.status).toBe("escalated");
    expect(escalated.task.history.at(-1)?.reason).toMatch(/2 review round/);
    expect(escalated.effects).toEqual([
      {
        type: "escalate",
        reason: expect.stringContaining("review round") as string,
        // With no escalation path drawn, the owner is who hears about it.
        to: { kind: "owner", hops: 0 },
      },
      {
        type: "notify",
        audience: "owner",
        message: expect.stringContaining("Write the parser") as string,
      },
    ]);
    expect(reviewRounds(escalated.task)).toBe(2);
  });

  it("sends the escalation up the reporting line when the office has one", () => {
    const policy = manager(1);
    const chief = "emp-chief" as EmployeeId;
    const escalationGraph = {
      employees: [
        { id: ada, departmentId, supervisorId: chief, status: "active" as const },
        { id: chief, departmentId, supervisorId: null, status: "active" as const },
      ],
      connections: [],
    };
    let current = task("in_review", { reviewerIds: [boss] });
    current = unwrap(
      engine.handle(
        current,
        { type: "request_changes", actorId: boss, reason: "round 1" },
        {
          policy,
          now: nextTime(),
          supervisorId: boss,
          escalationGraph,
        },
      ),
    ).task;
    current = unwrap(
      engine.handle(
        current,
        { type: "submit", actorId: ada },
        {
          policy,
          now: nextTime(),
          supervisorId: boss,
          escalationGraph,
        },
      ),
    ).task;
    const escalated = unwrap(
      engine.handle(
        current,
        { type: "request_changes", actorId: boss, reason: "round 2" },
        {
          policy,
          now: nextTime(),
          supervisorId: boss,
          escalationGraph,
        },
      ),
    );
    expect(escalated.task.status).toBe("escalated");
    expect(escalated.effects[0]).toMatchObject({
      type: "escalate",
      to: { kind: "employee", employeeId: chief },
    });
  });

  it("walks the full review loop from assigned to done", () => {
    let current = task("assigned");
    current = run(current, { type: "start", actorId: ada }).task;
    current = run(current, { type: "submit", actorId: ada }).task;
    current = run(current, { type: "request_changes", actorId: boss, reason: "add tests" }).task;
    current = run(current, { type: "submit", actorId: ada }).task;
    const done = run(current, { type: "approve", actorId: boss }).task;
    expect(done.status).toBe("done");
    expect(done.history.map((h) => h.to)).toEqual([
      "assigned",
      "in_progress",
      "in_review",
      "changes_requested",
      "in_progress",
      "in_review",
      "approved",
      "done",
    ]);
  });
});

describe("policy configuration", () => {
  it("refuses to run against a policy that carries no iteration cap", () => {
    const result = MANAGER_POLICY_HANDLER.handle(
      task("in_review", { reviewerIds: [boss] }),
      { type: "request_changes", actorId: boss, reason: "needs work" },
      { policy: { kind: "direct" }, now: t0, supervisorId: boss },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/maxIterations/);
  });
});

describe("registration", () => {
  it("ships in the default engine alongside direct", () => {
    expect(engine.policyKinds()).toContain("manager");
    expect(MANAGER_POLICY_HANDLER.kind).toBe("manager");
  });
});

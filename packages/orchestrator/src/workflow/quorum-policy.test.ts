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
import { QUORUM_POLICY_HANDLER } from "./quorum-policy.js";
import { rankPeers, type PeerCandidate } from "./peer-policy.js";
import {
  defaultWorkflowEngine,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowOutcome,
} from "./workflow-engine.js";

const officeId = "office-1" as OfficeId;
const departmentId = "dept-eng" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const bob = "emp-bob" as EmployeeId;
const cyd = "emp-cyd" as EmployeeId;
const dee = "emp-dee" as EmployeeId;
const t0 = new Date("2026-09-27T09:00:00Z");
let clock = 0;
const nextTime = (): Date => new Date(t0.getTime() + ++clock * 60_000);

function task(status: TaskStatus = "in_progress", overrides: Partial<Task> = {}): Task {
  const created = unwrap(
    createTask(
      { officeId, departmentId, title: "Ship the migration", assigneeId: ada },
      { id: () => "task-1" as TaskId, now: () => t0 },
    ),
  );
  return { ...created, status, ...overrides };
}

const quorum = (required: number, maxIterations = 3): ReviewPolicy => ({
  kind: "quorum",
  required,
  maxIterations,
});
const candidate = (id: EmployeeId, overrides: Partial<PeerCandidate> = {}): PeerCandidate => ({
  id,
  departmentId,
  status: "active",
  skillIds: [],
  openTasks: 0,
  ...overrides,
});
const committee = [candidate(bob), candidate(cyd), candidate(dee)];

const context = (
  policy: ReviewPolicy,
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({
  policy,
  now: nextTime(),
  supervisorId: null,
  peers: committee,
  ...overrides,
});

const engine = defaultWorkflowEngine();
const run = (
  current: Task,
  event: WorkflowEvent,
  policy: ReviewPolicy,
  overrides: Partial<WorkflowContext> = {},
): WorkflowOutcome => unwrap(engine.handle(current, event, context(policy, overrides)));

describe("rankPeers", () => {
  it("orders the whole pool so a committee can be taken from the top", () => {
    const peers = [
      candidate(dee, { openTasks: 1 }),
      candidate(bob, { skillIds: ["sql"] }),
      candidate(cyd, { openTasks: 0 }),
    ];
    expect(rankPeers(peers, { assigneeId: ada, reviewSkills: ["sql"] }).map((p) => p.id)).toEqual([
      bob,
      cyd,
      dee,
    ]);
  });

  it("drops the assignee and anyone not active", () => {
    const peers = [candidate(ada), candidate(bob, { status: "terminated" }), candidate(cyd)];
    expect(rankPeers(peers, { assigneeId: ada, reviewSkills: [] }).map((p) => p.id)).toEqual([cyd]);
  });
});

describe("quorum policy: submit", () => {
  it("names exactly the required number of reviewers and starts with no approvals", () => {
    const outcome = run(task("in_progress"), { type: "submit", actorId: ada }, quorum(2));
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.reviewerIds).toEqual([bob, cyd]);
    expect(outcome.task.approvals).toEqual([]);
    expect(outcome.effects[0]).toMatchObject({ audience: "reviewer" });
  });

  it("refuses when the department cannot staff the committee", () => {
    const result = engine.handle(
      task("in_progress"),
      { type: "submit", actorId: ada },
      context(quorum(4)),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]?.path).toBe("policy.required");
      expect(result.error[0]?.message).toMatch(/4/);
      expect(result.error[0]?.message).toMatch(/3/);
    }
  });

  it("clears approvals gathered in an earlier round", () => {
    const stale = task("in_progress", { approvals: [bob] });
    expect(run(stale, { type: "submit", actorId: ada }, quorum(2)).task.approvals).toEqual([]);
  });
});

describe("quorum policy: gathering approvals", () => {
  const reviewing = (approvals: EmployeeId[] = []): Task =>
    task("in_review", { reviewerIds: [bob, cyd], approvals });

  it("stays in review until the required approvals arrive", () => {
    const first = run(reviewing(), { type: "approve", actorId: bob }, quorum(2));
    expect(first.task.status).toBe("in_review");
    expect(first.task.approvals).toEqual([bob]);
    expect(first.effects[0]).toMatchObject({
      audience: "reviewer",
      message: expect.stringContaining("1 of 2") as string,
    });
  });

  it("completes the task once the quorum is reached", () => {
    const done = run(reviewing([bob]), { type: "approve", actorId: cyd }, quorum(2));
    expect(done.task.status).toBe("done");
    expect(done.task.approvals).toEqual([bob, cyd]);
    expect(done.task.history.map((h) => h.to)).toEqual(["assigned", "approved", "done"]);
  });

  it("counts a repeated approval from the same reviewer only once", () => {
    const again = run(reviewing([bob]), { type: "approve", actorId: bob }, quorum(2));
    expect(again.task.status).toBe("in_review");
    expect(again.task.approvals).toEqual([bob]);
  });

  it("refuses an approval from someone outside the committee", () => {
    const result = engine.handle(
      reviewing(),
      { type: "approve", actorId: dee },
      context(quorum(2)),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/not a reviewer/);
  });

  it("only gathers approvals while the task is in review", () => {
    const result = engine.handle(
      task("in_progress", { reviewerIds: [bob, cyd] }),
      { type: "approve", actorId: bob },
      context(quorum(2)),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/in review/);
  });

  it("completes immediately when a single approval is required", () => {
    const done = run(
      task("in_review", { reviewerIds: [bob], approvals: [] }),
      { type: "approve", actorId: bob },
      quorum(1),
    );
    expect(done.task.status).toBe("done");
  });
});

describe("quorum policy: rejection", () => {
  it("sends the work back on one rejection however many approvals were gathered", () => {
    const reviewing = task("in_review", { reviewerIds: [bob, cyd, dee], approvals: [bob, cyd] });
    const outcome = run(
      reviewing,
      { type: "request_changes", actorId: dee, reason: "the migration is not reversible" },
      quorum(3),
    );
    expect(outcome.task.status).toBe("in_progress");
    expect(outcome.task.approvals).toEqual([]);
    expect(outcome.task.history.find((h) => h.to === "changes_requested")?.reason).toBe(
      "the migration is not reversible",
    );
  });

  it("still escalates once the round cap is used up", () => {
    const policy = quorum(2, 1);
    let current = task("in_review", { reviewerIds: [bob, cyd] });
    current = run(
      current,
      { type: "request_changes", actorId: bob, reason: "round 1" },
      policy,
    ).task;
    current = run(current, { type: "submit", actorId: ada }, policy).task;
    const escalated = run(
      current,
      { type: "request_changes", actorId: bob, reason: "round 2" },
      policy,
    );
    expect(escalated.task.status).toBe("escalated");
    expect(escalated.effects[0]).toMatchObject({ type: "escalate" });
  });
});

describe("quorum policy: configuration", () => {
  it("refuses a policy that carries no required count", () => {
    const result = QUORUM_POLICY_HANDLER.handle(
      task("in_review", { reviewerIds: [bob] }),
      { type: "approve", actorId: bob },
      { policy: { kind: "manager", maxIterations: 3 }, now: t0, peers: committee },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/required/);
  });

  it("ships in the default engine", () => {
    expect(engine.policyKinds()).toContain("quorum");
    expect(QUORUM_POLICY_HANDLER.kind).toBe("quorum");
  });
});

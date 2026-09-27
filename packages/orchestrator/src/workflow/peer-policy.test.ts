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
import { PEER_POLICY_HANDLER, selectPeerReviewer, type PeerCandidate } from "./peer-policy.js";
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

const peer = (maxIterations = 3): ReviewPolicy => ({ kind: "peer", maxIterations });
const candidate = (id: EmployeeId, overrides: Partial<PeerCandidate> = {}): PeerCandidate => ({
  id,
  status: "active",
  skillIds: [],
  openTasks: 0,
  ...overrides,
});

const context = (overrides: Partial<WorkflowContext> = {}): WorkflowContext => ({
  policy: peer(),
  now: nextTime(),
  supervisorId: boss,
  ...overrides,
});

const engine = defaultWorkflowEngine();
const run = (
  current: Task,
  event: WorkflowEvent,
  overrides: Partial<WorkflowContext> = {},
): WorkflowOutcome => unwrap(engine.handle(current, event, context(overrides)));

describe("selectPeerReviewer", () => {
  it("prefers the peer with the most overlapping skills", () => {
    const peers = [
      candidate(bob, { skillIds: ["tdd"] }),
      candidate(cyd, { skillIds: ["tdd", "parsers"] }),
    ];
    expect(selectPeerReviewer(peers, { assigneeId: ada, reviewSkills: ["tdd", "parsers"] })).toBe(
      cyd,
    );
  });

  it("never picks the assignee", () => {
    const peers = [candidate(ada, { skillIds: ["tdd", "parsers"] }), candidate(bob)];
    expect(selectPeerReviewer(peers, { assigneeId: ada, reviewSkills: ["tdd"] })).toBe(bob);
  });

  it("never picks a paused or terminated employee", () => {
    const peers = [
      candidate(bob, { status: "paused", skillIds: ["tdd"] }),
      candidate(cyd, { status: "terminated", skillIds: ["tdd"] }),
    ];
    expect(selectPeerReviewer(peers, { assigneeId: ada, reviewSkills: ["tdd"] })).toBeNull();
  });

  it("breaks a skill tie with the lowest open-task load", () => {
    const peers = [
      candidate(bob, { skillIds: ["tdd"], openTasks: 5 }),
      candidate(cyd, { skillIds: ["tdd"], openTasks: 1 }),
    ];
    expect(selectPeerReviewer(peers, { assigneeId: ada, reviewSkills: ["tdd"] })).toBe(cyd);
  });

  it("breaks a skill and load tie by id, so the choice is deterministic", () => {
    const peers = [candidate(cyd, { skillIds: ["tdd"] }), candidate(bob, { skillIds: ["tdd"] })];
    expect(selectPeerReviewer(peers, { assigneeId: ada, reviewSkills: ["tdd"] })).toBe(bob);
    expect(
      selectPeerReviewer([...peers].reverse(), { assigneeId: ada, reviewSkills: ["tdd"] }),
    ).toBe(bob);
  });

  it("still picks someone when no skills are required", () => {
    const peers = [candidate(cyd, { openTasks: 2 }), candidate(bob, { openTasks: 3 })];
    expect(selectPeerReviewer(peers, { assigneeId: ada, reviewSkills: [] })).toBe(cyd);
  });

  it("returns null when the department has nobody else", () => {
    expect(selectPeerReviewer([], { assigneeId: ada, reviewSkills: ["tdd"] })).toBeNull();
    expect(selectPeerReviewer([candidate(ada)], { assigneeId: ada, reviewSkills: [] })).toBeNull();
  });
});

describe("peer policy: submit", () => {
  it("assigns an eligible peer as the reviewer and notifies them", () => {
    const outcome = run(
      task("in_progress"),
      { type: "submit", actorId: ada },
      {
        peers: [candidate(bob, { skillIds: ["tdd"] }), candidate(cyd)],
        reviewSkills: ["tdd"],
      },
    );
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.reviewerIds).toEqual([bob]);
    expect(outcome.effects).toEqual([
      {
        type: "notify",
        audience: "reviewer",
        message: expect.stringContaining("Write the parser") as string,
      },
    ]);
  });

  it("falls back to the supervisor when no peer is eligible", () => {
    const outcome = run(
      task("in_progress"),
      { type: "submit", actorId: ada },
      {
        peers: [candidate(ada), candidate(bob, { status: "paused" })],
      },
    );
    expect(outcome.task.reviewerIds).toEqual([boss]);
    expect(outcome.effects[0]).toMatchObject({ audience: "supervisor" });
  });

  it("falls back to the office owner when there is neither a peer nor a supervisor", () => {
    const outcome = run(
      task("in_progress"),
      { type: "submit", actorId: ada },
      { peers: [], supervisorId: null },
    );
    expect(outcome.task.reviewerIds).toEqual([]);
    expect(outcome.effects[0]).toMatchObject({ audience: "owner" });
  });

  it("treats an absent peer list as no eligible peers", () => {
    const outcome = run(task("in_progress"), { type: "submit", actorId: ada });
    expect(outcome.task.reviewerIds).toEqual([boss]);
  });

  it("refuses when the only fallback is a supervisor who is the assignee", () => {
    const result = engine.handle(
      task("in_progress"),
      { type: "submit", actorId: ada },
      context({ peers: [], supervisorId: ada }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/own work/);
  });

  it("records submitted artifacts", () => {
    const outcome = run(
      task("in_progress"),
      { type: "submit", actorId: ada, artifacts: ["git://acme/pr/9"] },
      {
        peers: [candidate(bob)],
      },
    );
    expect(outcome.task.artifacts).toEqual(["git://acme/pr/9"]);
  });
});

describe("peer policy: shared review mechanics", () => {
  it("lets the chosen peer approve and complete the task", () => {
    const reviewing = task("in_review", { reviewerIds: [bob] });
    const outcome = run(reviewing, { type: "approve", actorId: bob }, { peers: [candidate(bob)] });
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.history.map((h) => h.to)).toEqual(["assigned", "approved", "done"]);
  });

  it("refuses an approval from someone who is not the chosen peer", () => {
    const reviewing = task("in_review", { reviewerIds: [bob] });
    const result = engine.handle(
      reviewing,
      { type: "approve", actorId: cyd },
      context({ peers: [candidate(bob)] }),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/not a reviewer/);
  });

  it("sends the work back on a change request and escalates past the cap", () => {
    const policy = peer(1);
    let current = task("in_review", { reviewerIds: [bob] });
    current = run(
      current,
      { type: "request_changes", actorId: bob, reason: "needs tests" },
      { policy },
    ).task;
    expect(current.status).toBe("in_progress");

    current = run(
      current,
      { type: "submit", actorId: ada },
      { policy, peers: [candidate(bob)] },
    ).task;
    const escalated = run(
      current,
      { type: "request_changes", actorId: bob, reason: "still not right" },
      { policy },
    );
    expect(escalated.task.status).toBe("escalated");
    expect(escalated.effects[0]).toMatchObject({ type: "escalate" });
  });
});

describe("registration", () => {
  it("ships in the default engine", () => {
    expect(engine.policyKinds()).toContain("peer");
    expect(PEER_POLICY_HANDLER.kind).toBe("peer");
  });
});

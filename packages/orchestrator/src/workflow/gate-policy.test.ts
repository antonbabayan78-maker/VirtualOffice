import { describe, expect, it } from "vitest";
import {
  createTask,
  isErr,
  unwrap,
  type DepartmentId,
  type EmployeeId,
  type GatedAction,
  type OfficeId,
  type ReviewPolicy,
  type Task,
  type TaskId,
  type TaskStatus,
} from "@vo/core";
import { GATE_POLICY_HANDLER } from "./gate-policy.js";
import {
  defaultWorkflowEngine,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowOutcome,
} from "./workflow-engine.js";

const officeId = "office-1" as OfficeId;
const departmentId = "dept-ops" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const boss = "emp-boss" as EmployeeId;
const t0 = new Date("2026-09-27T09:00:00Z");
let clock = 0;
const nextTime = (): Date => new Date(t0.getTime() + ++clock * 60_000);

const OWNER = "anton@example.com";

function task(
  status: TaskStatus = "in_progress",
  gatedActions: readonly GatedAction[] = [],
  overrides: Partial<Task> = {},
): Task {
  const created = unwrap(
    createTask(
      { officeId, departmentId, title: "Deploy the new pricing", assigneeId: ada, gatedActions },
      { id: () => "task-1" as TaskId, now: () => t0 },
    ),
  );
  return { ...created, status, ...overrides };
}

const gate = (gatedActions: readonly GatedAction[] = ["deploy"]): ReviewPolicy => ({
  kind: "gate",
  gatedActions,
});

const context = (
  policy: ReviewPolicy = gate(),
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({ policy, now: nextTime(), supervisorId: boss, ...overrides });

const engine = defaultWorkflowEngine();
const run = (current: Task, event: WorkflowEvent, policy: ReviewPolicy = gate()): WorkflowOutcome =>
  unwrap(engine.handle(current, event, context(policy)));

describe("gate policy: work that needs nobody", () => {
  it("lets work with no consequential action through without a gate", () => {
    const outcome = run(task("in_progress", []), { type: "submit", actorId: ada });
    expect(outcome.task.status).toBe("done");
    expect(outcome.effects.some((e) => e.type === "request_approval")).toBe(false);
  });

  it("lets work through when none of its actions are the gated ones", () => {
    const outcome = run(
      task("in_progress", ["spend"]),
      { type: "submit", actorId: ada },
      gate(["deploy"]),
    );
    expect(outcome.task.status).toBe("done");
  });
});

describe("gate policy: work that needs a person", () => {
  it("holds the work and asks the owner, listing only the gated categories", () => {
    const outcome = run(
      task("in_progress", ["delete", "spend", "deploy"]),
      { type: "submit", actorId: ada },
      gate(["deploy", "delete"]),
    );
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.effects).toContainEqual({
      type: "request_approval",
      gates: ["deploy", "delete"],
      summary: 'task "Deploy the new pricing" involves deploy, delete and needs an owner decision',
    });
    expect(outcome.effects).toContainEqual({
      type: "notify",
      audience: "owner",
      message: 'task "Deploy the new pricing" is waiting for your approval: deploy, delete',
    });
  });

  it("completes the task on the owner's approval and records who decided", () => {
    const outcome = run(task("in_review", ["deploy"]), {
      type: "gate_decided",
      decision: "approved",
      decidedBy: OWNER,
    });
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.history.map((h) => h.to)).toEqual(["assigned", "approved", "done"]);
    expect(outcome.task.history.find((h) => h.to === "approved")?.reason).toContain(OWNER);
    // A human decided, so no employee is recorded as the actor.
    expect(outcome.task.history.find((h) => h.to === "approved")?.actorId).toBeNull();
  });

  it("returns the work with the owner's stated reason on rejection", () => {
    const outcome = run(task("in_review", ["deploy"]), {
      type: "gate_decided",
      decision: "rejected",
      decidedBy: OWNER,
      reason: "not on a Friday afternoon",
    });
    expect(outcome.task.status).toBe("in_progress");
    expect(outcome.task.history.find((h) => h.to === "changes_requested")?.reason).toBe(
      "not on a Friday afternoon",
    );
    expect(outcome.effects[0]).toMatchObject({ audience: "assignee" });
  });

  it("refuses a rejection with no reason for the assignee to act on", () => {
    const result = engine.handle(
      task("in_review", ["deploy"]),
      { type: "gate_decided", decision: "rejected", decidedBy: OWNER, reason: "   " },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.path).toBe("reason");
  });

  it("refuses a decision that names no decider", () => {
    const result = engine.handle(
      task("in_review", ["deploy"]),
      { type: "gate_decided", decision: "approved", decidedBy: "  " },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.path).toBe("decidedBy");
  });

  it("refuses a decision about work that is not waiting for one", () => {
    const result = engine.handle(
      task("in_progress", ["deploy"]),
      { type: "gate_decided", decision: "approved", decidedBy: OWNER },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/in review/);
  });

  it("does not let an agent approve or reject in the owner's place", () => {
    for (const event of [
      { type: "approve", actorId: boss } as const,
      { type: "request_changes", actorId: boss, reason: "looks fine to me" } as const,
    ]) {
      const result = engine.handle(task("in_review", ["deploy"]), event, context());
      expect(isErr(result), event.type).toBe(true);
      if (isErr(result)) expect(result.error[0]?.message).toMatch(/human|owner/);
    }
  });
});

describe("gate policy: registration", () => {
  it("ships in the default engine", () => {
    expect(engine.policyKinds()).toContain("gate");
    expect(GATE_POLICY_HANDLER.kind).toBe("gate");
  });

  it("is refused, never ignored, by every policy without a gate", () => {
    const policies: readonly ReviewPolicy[] = [
      { kind: "direct" },
      { kind: "manager", maxIterations: 3 },
      { kind: "peer", maxIterations: 3 },
      { kind: "quorum", required: 2, maxIterations: 3 },
      {
        kind: "pipeline",
        stages: [{ name: "QA", workerId: null, reviewerIds: [], required: 1 }],
        maxIterations: 3,
      },
      { kind: "automated", checkId: "unit-tests", maxIterations: 3 },
    ];
    for (const policy of policies) {
      const result = engine.handle(
        task("in_review", ["deploy"]),
        { type: "gate_decided", decision: "approved", decidedBy: OWNER },
        context(policy),
      );
      expect(isErr(result), policy.kind).toBe(true);
      if (isErr(result)) expect(result.error[0]?.message).toContain(policy.kind);
    }
  });
});

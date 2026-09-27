import { describe, expect, it } from "vitest";
import {
  createTask,
  isErr,
  unwrap,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type ReviewPolicy,
  type ReviewStage,
  type Task,
  type TaskId,
  type TaskStatus,
} from "@vo/core";
import { PIPELINE_POLICY_HANDLER } from "./pipeline-policy.js";
import {
  defaultWorkflowEngine,
  type WorkflowContext,
  type WorkflowEvent,
  type WorkflowOutcome,
} from "./workflow-engine.js";

const officeId = "office-1" as OfficeId;
const departmentId = "dept-content" as DepartmentId;
const ada = "emp-ada" as EmployeeId; // drafts
const qa = "emp-qa" as EmployeeId; // runs QA
const lee = "emp-lee" as EmployeeId; // legal
const boss = "emp-boss" as EmployeeId;
const editor = "emp-editor" as EmployeeId;
const arch = "emp-arch" as EmployeeId;
const t0 = new Date("2026-09-27T09:00:00Z");
let clock = 0;
const nextTime = (): Date => new Date(t0.getTime() + ++clock * 60_000);

function task(status: TaskStatus = "in_progress", overrides: Partial<Task> = {}): Task {
  const created = unwrap(
    createTask(
      { officeId, departmentId, title: "Launch announcement", assigneeId: ada },
      { id: () => "task-1" as TaskId, now: () => t0 },
    ),
  );
  return { ...created, status, ...overrides };
}

const stage = (name: string, overrides: Partial<ReviewStage> = {}): ReviewStage => ({
  name,
  workerId: null,
  reviewerIds: [],
  required: 1,
  ...overrides,
});

/** Draft (Ada, edited by the editor) -> QA (qa, signed off by lead and architect) -> Legal (lee, boss signs). */
const STAGES: readonly ReviewStage[] = [
  stage("Draft", { workerId: ada, reviewerIds: [editor] }),
  stage("QA", { workerId: qa, reviewerIds: [editor, arch], required: 2 }),
  stage("Legal", { workerId: lee, reviewerIds: [boss] }),
];

const pipeline = (stages: readonly ReviewStage[] = STAGES, maxIterations = 3): ReviewPolicy => ({
  kind: "pipeline",
  stages,
  maxIterations,
});

const context = (
  policy: ReviewPolicy = pipeline(),
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({ policy, now: nextTime(), supervisorId: boss, ...overrides });

const engine = defaultWorkflowEngine();
const run = (
  current: Task,
  event: WorkflowEvent,
  policy: ReviewPolicy = pipeline(),
  overrides: Partial<WorkflowContext> = {},
): WorkflowOutcome => unwrap(engine.handle(current, event, context(policy, overrides)));

describe("pipeline policy: entering a stage", () => {
  it("submits into the first stage and names that stage's reviewers", () => {
    const outcome = run(task("in_progress"), { type: "submit", actorId: ada });
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.stage).toBe("Draft");
    expect(outcome.task.reviewerIds).toEqual([editor]);
    expect(outcome.task.approvals).toEqual([]);
  });

  it("resubmits into the stage the work is already at, not back to the first", () => {
    const reworked = task("in_progress", { stage: "QA", assigneeId: qa });
    const outcome = run(reworked, { type: "submit", actorId: qa });
    expect(outcome.task.stage).toBe("QA");
    expect(outcome.task.reviewerIds).toEqual([editor, arch]);
  });

  it("falls back to the supervisor for a stage that names no reviewers", () => {
    const solo = pipeline([stage("Legal", { workerId: lee })]);
    const outcome = run(
      task("in_progress", { assigneeId: lee }),
      { type: "submit", actorId: lee },
      solo,
    );
    expect(outcome.task.reviewerIds).toEqual([boss]);
    expect(outcome.effects[0]).toMatchObject({ audience: "supervisor" });
  });
});

describe("pipeline policy: advancing", () => {
  const reviewing = (stageName: string, overrides: Partial<Task> = {}): Task =>
    task("in_review", { stage: stageName, ...overrides });

  it("advances to the next stage instead of completing the task", () => {
    const outcome = run(reviewing("Draft", { reviewerIds: [editor] }), {
      type: "approve",
      actorId: editor,
    });
    expect(outcome.task.status).toBe("assigned");
    expect(outcome.task.stage).toBe("QA");
    expect(outcome.task.assigneeId).toBe(qa);
    expect(outcome.task.reviewerIds).toEqual([]);
    expect(outcome.task.approvals).toEqual([]);
    expect(outcome.task.history.map((h) => h.to)).toEqual(["assigned", "approved", "assigned"]);
  });

  it("holds a stage open until that stage has its approvals", () => {
    const outcome = run(reviewing("QA", { reviewerIds: [editor, arch], assigneeId: qa }), {
      type: "approve",
      actorId: editor,
    });
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.stage).toBe("QA");
    expect(outcome.task.approvals).toEqual([editor]);
  });

  it("completes the task when the final stage signs off", () => {
    const outcome = run(reviewing("Legal", { reviewerIds: [boss], assigneeId: lee }), {
      type: "approve",
      actorId: boss,
    });
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.stage).toBe("Legal");
    expect(outcome.effects[0]).toMatchObject({ audience: "assignee" });
  });

  it("runs the stages in declared order from submit to done", () => {
    const seen: (string | null)[] = [];
    let current = task("in_progress");
    for (const [index, declared] of STAGES.entries()) {
      current = run(current, { type: "submit", actorId: current.assigneeId ?? ada }).task;
      seen.push(current.stage);
      expect(current.stage).toBe(declared.name);
      for (const reviewer of current.reviewerIds) {
        current = run(current, { type: "approve", actorId: reviewer }).task;
      }
      const isLast = index === STAGES.length - 1;
      expect(current.status).toBe(isLast ? "done" : "assigned");
      if (!isLast) current = { ...current, status: "in_progress" };
    }
    expect(seen).toEqual(["Draft", "QA", "Legal"]);
  });

  it("refuses an approval from outside the current stage's reviewers", () => {
    const result = engine.handle(
      reviewing("Legal", { reviewerIds: [boss], assigneeId: lee }),
      { type: "approve", actorId: arch },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/not a reviewer/);
  });
});

describe("pipeline policy: rejection", () => {
  it("returns the work to the current stage's worker and stays at that stage", () => {
    const reviewing = task("in_review", {
      stage: "QA",
      reviewerIds: [editor, arch],
      assigneeId: ada,
    });
    const outcome = run(reviewing, {
      type: "request_changes",
      actorId: arch,
      reason: "the benchmark table is stale",
    });
    expect(outcome.task.status).toBe("in_progress");
    expect(outcome.task.stage).toBe("QA");
    expect(outcome.task.assigneeId).toBe(qa);
    expect(outcome.task.approvals).toEqual([]);
  });

  it("escalates once the round cap is spent", () => {
    const policy = pipeline(STAGES, 1);
    let current = task("in_review", { stage: "Draft", reviewerIds: [editor] });
    current = run(
      current,
      { type: "request_changes", actorId: editor, reason: "round 1" },
      policy,
    ).task;
    current = run(current, { type: "submit", actorId: ada }, policy).task;
    const escalated = run(
      current,
      { type: "request_changes", actorId: editor, reason: "round 2" },
      policy,
    );
    expect(escalated.task.status).toBe("escalated");
    expect(escalated.effects[0]).toMatchObject({ type: "escalate" });
  });
});

describe("pipeline policy: configuration", () => {
  it("refuses a task sitting at a stage the department no longer declares", () => {
    const result = engine.handle(
      task("in_review", { stage: "Ops", reviewerIds: [boss] }),
      { type: "approve", actorId: boss },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]?.path).toBe("stage");
      expect(result.error[0]?.message).toMatch(/Ops/);
    }
  });

  it("refuses a policy that declares no stages", () => {
    const result = PIPELINE_POLICY_HANDLER.handle(
      task("in_progress"),
      { type: "submit", actorId: ada },
      { policy: { kind: "manager", maxIterations: 3 }, now: t0 },
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/stages/);
  });

  it("ships in the default engine", () => {
    expect(engine.policyKinds()).toContain("pipeline");
    expect(PIPELINE_POLICY_HANDLER.kind).toBe("pipeline");
  });
});

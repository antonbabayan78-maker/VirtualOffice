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
import { AUTOMATED_POLICY_HANDLER, CHECK_OUTPUT_MAX_LENGTH } from "./automated-policy.js";
import type { CheckOutcome, CheckReport } from "./check-runner.js";
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

const CHECK = "unit-tests";

function task(status: TaskStatus = "in_progress", overrides: Partial<Task> = {}): Task {
  const created = unwrap(
    createTask(
      { officeId, departmentId, title: "Add the retry", assigneeId: ada },
      { id: () => "task-1" as TaskId, now: () => t0 },
    ),
  );
  return { ...created, status, ...overrides };
}

const automated = (maxIterations = 3): ReviewPolicy => ({
  kind: "automated",
  checkId: CHECK,
  maxIterations,
});

const report = (outcome: CheckOutcome, output = "", checkId = CHECK): CheckReport => ({
  checkId,
  outcome,
  output,
});

const context = (
  policy: ReviewPolicy = automated(),
  overrides: Partial<WorkflowContext> = {},
): WorkflowContext => ({ policy, now: nextTime(), supervisorId: boss, ...overrides });

const engine = defaultWorkflowEngine();
const run = (
  current: Task,
  event: WorkflowEvent,
  policy: ReviewPolicy = automated(),
): WorkflowOutcome => unwrap(engine.handle(current, event, context(policy)));

describe("automated policy: queuing the check", () => {
  it("submits for review and asks for the check instead of naming a human reviewer", () => {
    const outcome = run(task("in_progress"), { type: "submit", actorId: ada });
    expect(outcome.task.status).toBe("in_review");
    expect(outcome.task.reviewerIds).toEqual([]);
    expect(outcome.effects).toContainEqual({ type: "run_check", checkId: CHECK });
  });
});

describe("automated policy: acting on the report", () => {
  const reviewing = (): Task => task("in_review");

  it("completes the task when the check passes", () => {
    const outcome = run(reviewing(), {
      type: "check_reported",
      report: report("passed", "42 passed"),
    });
    expect(outcome.task.status).toBe("done");
    expect(outcome.task.history.map((h) => h.to)).toEqual(["assigned", "approved", "done"]);
  });

  it("requests changes with the failure output as the reason", () => {
    const output = "FAIL src/retry.test.ts > gives up after three attempts\n  expected 3, got 4";
    const outcome = run(reviewing(), { type: "check_reported", report: report("failed", output) });
    expect(outcome.task.status).toBe("in_progress");
    expect(outcome.task.history.find((h) => h.to === "changes_requested")?.reason).toBe(output);
    expect(outcome.effects[0]).toMatchObject({ audience: "assignee" });
  });

  it("escalates when the check itself errors instead of approving", () => {
    const outcome = run(reviewing(), {
      type: "check_reported",
      report: report("errored", "vitest: command not found"),
    });
    expect(outcome.task.status).toBe("escalated");
    expect(outcome.effects[0]).toMatchObject({ type: "escalate" });
    if (outcome.effects[0]?.type === "escalate") {
      expect(outcome.effects[0].reason).toMatch(/command not found/);
    }
  });

  it("escalates once the failing rounds are spent", () => {
    const policy = automated(1);
    let current = run(
      reviewing(),
      { type: "check_reported", report: report("failed", "round 1") },
      policy,
    ).task;
    current = run(current, { type: "submit", actorId: ada }, policy).task;
    const escalated = run(
      current,
      { type: "check_reported", report: report("failed", "round 2") },
      policy,
    );
    expect(escalated.task.status).toBe("escalated");
  });

  it("truncates a huge log rather than storing it whole on the task", () => {
    const output = "x".repeat(CHECK_OUTPUT_MAX_LENGTH + 500);
    const outcome = run(reviewing(), { type: "check_reported", report: report("failed", output) });
    const reason = outcome.task.history.find((h) => h.to === "changes_requested")?.reason ?? "";
    expect(reason.length).toBeLessThan(output.length);
    expect(reason).toMatch(/truncated/);
  });

  it("refuses a report about a different check", () => {
    const result = engine.handle(
      reviewing(),
      { type: "check_reported", report: report("passed", "", "lint") },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error[0]?.path).toBe("report.checkId");
      expect(result.error[0]?.message).toMatch(/lint/);
    }
  });

  it("refuses a report about work that is not in review", () => {
    const result = engine.handle(
      task("in_progress"),
      { type: "check_reported", report: report("passed") },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/in review/);
  });
});

describe("automated policy: no human shortcut", () => {
  it("refuses a human approval, because the check decides", () => {
    const result = engine.handle(task("in_review"), { type: "approve", actorId: boss }, context());
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/check/);
  });

  it("refuses a human change request too", () => {
    const result = engine.handle(
      task("in_review"),
      { type: "request_changes", actorId: boss, reason: "looks wrong" },
      context(),
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error[0]?.message).toMatch(/check/);
  });
});

describe("automated policy: registration", () => {
  it("ships in the default engine", () => {
    expect(engine.policyKinds()).toContain("automated");
    expect(AUTOMATED_POLICY_HANDLER.kind).toBe("automated");
  });

  it("is refused, never ignored, by every policy that runs no checks", () => {
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
    ];
    for (const policy of policies) {
      const result = engine.handle(
        task("in_review"),
        { type: "check_reported", report: report("passed") },
        context(policy),
      );
      expect(isErr(result), policy.kind).toBe(true);
      // Each refusal names the policy that cannot act on the report.
      if (isErr(result)) expect(result.error[0]?.message).toContain(policy.kind);
    }
  });
});

import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import {
  canTransition,
  createTask,
  isPriority,
  openTaskCounts,
  PRIORITY_RANK,
  type CreateTaskInput,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX_LENGTH,
  TASK_TRANSITIONS,
  TERMINAL_TASK_STATUSES,
  transitionTask,
  type Task,
  type TaskId,
  type TaskStatus,
} from "./task.js";

const officeId = "office-1" as OfficeId;
const departmentId = "dept-1" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const bob = "emp-bob" as EmployeeId;
const t0 = new Date("2026-09-22T00:00:00Z");
const t1 = new Date("2026-09-22T01:00:00Z");
const deps = { id: () => "task-1" as TaskId, now: () => t0 };
const base = { officeId, departmentId, title: "Write the parser" };

function make(overrides: Record<string, unknown> = {}): Task {
  return unwrap(createTask({ ...base, ...overrides }, deps));
}

/** Drive a task along a path of statuses, returning the final task. */
function walk(task: Task, path: TaskStatus[]): Task {
  return path.reduce((t, to) => unwrap(transitionTask(t, to, { at: t1, actorId: ada })), task);
}

describe("createTask", () => {
  it("creates a backlog task with defaults and one initial history event", () => {
    const task = make();
    expect(task).toEqual<Task>({
      id: "task-1" as TaskId,
      officeId,
      departmentId,
      title: "Write the parser",
      brief: "",
      priority: "normal",
      status: "backlog",
      assigneeId: null,
      reviewerIds: [],
      approvals: [],
      stage: null,
      gatedActions: [],
      dependsOn: [],
      artifacts: [],
      route: [],
      acceptanceCriteria: [],
      checkedBy: [],
      tokenBudget: null,
      deadline: null,
      history: [{ at: t0, from: null, to: "backlog", actorId: null, reason: null }],
      createdAt: t0,
      updatedAt: t0,
    });
  });

  it("records which consequential actions the work involves", () => {
    expect(make().gatedActions).toEqual([]);
    expect(make({ gatedActions: ["deploy", "spend"] }).gatedActions).toEqual(["deploy", "spend"]);
  });

  it("rejects unknown or repeated gated actions", () => {
    const unknown = createTask(
      { ...base, gatedActions: ["launch_rocket"] } as unknown as CreateTaskInput,
      deps,
    );
    expect(isErr(unknown)).toBe(true);
    if (isErr(unknown)) expect(unknown.error[0]?.path).toBe("gatedActions");

    const repeated = createTask(
      { ...base, gatedActions: ["deploy", "deploy"] } as unknown as CreateTaskInput,
      deps,
    );
    expect(isErr(repeated)).toBe(true);
    if (isErr(repeated)) expect(repeated.error[0]?.path).toBe("gatedActions");
  });

  it("starts outside any review pipeline stage", () => {
    expect(make().stage).toBeNull();
  });

  it("hands an approved task on to the next pipeline stage", () => {
    const approved = walk(make({ assigneeId: ada }), ["in_progress", "in_review", "approved"]);
    const handed = transitionTask(approved, "assigned", {
      at: t1,
      actorId: ada,
      reason: "cleared Draft",
    });
    expect(isOk(handed)).toBe(true);
    expect(unwrap(handed).status).toBe("assigned");
  });

  it("starts with no approvals gathered", () => {
    expect(make().approvals).toEqual([]);
    expect(make({ assigneeId: ada }).approvals).toEqual([]);
  });

  it("starts as assigned when an assignee is given", () => {
    const task = make({ assigneeId: ada });
    expect(task.status).toBe("assigned");
    expect(task.assigneeId).toBe(ada);
    expect(task.history[0]?.to).toBe("assigned");
  });

  it("accepts brief, priority, reviewers, dependencies, token budget and deadline", () => {
    const deadline = new Date("2026-10-01T00:00:00Z");
    const task = make({
      brief: "Parse YAML offices.",
      priority: "high",
      reviewerIds: [bob],
      dependsOn: ["task-0"],
      tokenBudget: 50_000,
      deadline,
    });
    expect(task.brief).toBe("Parse YAML offices.");
    expect(task.priority).toBe("high");
    expect(task.reviewerIds).toEqual([bob]);
    expect(task.dependsOn).toEqual(["task-0"]);
    expect(task.tokenBudget).toBe(50_000);
    expect(task.deadline).toEqual(deadline);
  });

  it("trims the title and rejects empty or over-long titles", () => {
    expect(make({ title: "  Fix it  " }).title).toBe("Fix it");
    for (const title of ["", " ", "x".repeat(201)]) {
      const r = createTask({ ...base, title }, deps);
      expect(isErr(r), JSON.stringify(title)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe("title");
    }
  });

  it("rejects an unknown priority, a non-positive token budget and an invalid deadline", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["priority", { priority: "asap" }],
      ["tokenBudget", { tokenBudget: 0 }],
      ["tokenBudget", { tokenBudget: 1.5 }],
      ["deadline", { deadline: new Date("nope") }],
    ];
    for (const [path, overrides] of cases) {
      const r = createTask({ ...base, ...overrides }, deps);
      expect(isErr(r), JSON.stringify(overrides)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe(path);
    }
  });

  it("rejects a task depending on itself or listing a dependency twice", () => {
    const self = createTask({ ...base, dependsOn: ["task-1"] }, deps);
    expect(isErr(self)).toBe(true);
    if (isErr(self)) expect(self.error[0]?.message).toMatch(/itself/);
    const dup = createTask({ ...base, dependsOn: ["task-0", "task-0"] }, deps);
    expect(isErr(dup)).toBe(true);
  });

  it("rejects duplicate reviewers and a reviewer who is also the assignee", () => {
    const dup = createTask({ ...base, reviewerIds: [bob, bob] }, deps);
    expect(isErr(dup)).toBe(true);
    const self = createTask({ ...base, assigneeId: ada, reviewerIds: [ada] }, deps);
    expect(isErr(self)).toBe(true);
    if (isErr(self)) expect(self.error[0]?.message).toMatch(/own work/);
  });

  it("rejects a brief over 20,000 characters", () => {
    const r = createTask({ ...base, brief: "x".repeat(20_001) }, deps);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("brief");
  });
});

describe("transition table", () => {
  it("covers every status exactly once and terminal statuses have no exits", () => {
    expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATUSES].sort());
    for (const s of TERMINAL_TASK_STATUSES) expect(TASK_TRANSITIONS[s]).toEqual([]);
    expect(TERMINAL_TASK_STATUSES).toEqual(["done", "cancelled"]);
  });

  it("encodes the happy path and the side paths", () => {
    expect(TASK_TRANSITIONS.backlog).toEqual(["assigned", "cancelled"]);
    expect(TASK_TRANSITIONS.assigned).toEqual([
      "in_progress",
      "backlog",
      "blocked",
      "transferred",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.in_progress).toEqual([
      "in_review",
      "done",
      "blocked",
      "escalated",
      "transferred",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.in_review).toEqual([
      "approved",
      "changes_requested",
      "escalated",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.changes_requested).toEqual([
      "in_progress",
      "escalated",
      "transferred",
      "cancelled",
    ]);
    // "assigned" is the multi-stage pipeline hand-off: a stage signs off and the
    // work moves on to the next stage's worker instead of completing.
    expect(TASK_TRANSITIONS.approved).toEqual(["done", "assigned", "in_review"]);
    expect(TASK_TRANSITIONS.blocked).toEqual([
      "assigned",
      "in_progress",
      "escalated",
      "transferred",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.escalated).toEqual([
      "assigned",
      "in_progress",
      "transferred",
      "cancelled",
    ]);
    expect(TASK_TRANSITIONS.transferred).toEqual(["assigned", "cancelled"]);
  });

  it("canTransition agrees with the table for every pair", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(
          TASK_TRANSITIONS[from].includes(to),
        );
      }
    }
  });
});

describe("transitionTask", () => {
  it("applies every legal transition and appends exactly one history event each", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_TRANSITIONS[from]) {
        const start = { ...make({ assigneeId: ada }), status: from };
        const r = transitionTask(start, to, { at: t1, actorId: bob, reason: "test" });
        expect(isOk(r), `${from} -> ${to}`).toBe(true);
        const next = unwrap(r);
        expect(next.status).toBe(to);
        expect(next.history).toHaveLength(start.history.length + 1);
        expect(next.history.at(-1)).toEqual({ at: t1, from, to, actorId: bob, reason: "test" });
        expect(next.updatedAt).toEqual(t1);
      }
    }
  });

  it("rejects every illegal transition without touching history", () => {
    for (const from of TASK_STATUSES) {
      for (const to of TASK_STATUSES) {
        if (TASK_TRANSITIONS[from].includes(to)) continue;
        const start = { ...make({ assigneeId: ada }), status: from };
        const r = transitionTask(start, to, { at: t1, actorId: ada });
        expect(isErr(r), `${from} -> ${to} must be illegal`).toBe(true);
        if (isErr(r)) expect(r.error[0]).toMatchObject({ path: "status" });
        expect(start.history).toHaveLength(1);
      }
    }
  });

  it("walks the full review loop to done", () => {
    const done = walk(make({ assigneeId: ada }), [
      "in_progress",
      "in_review",
      "changes_requested",
      "in_progress",
      "in_review",
      "approved",
      "done",
    ]);
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

  it("requires an assignee to leave backlog and clears it when returning to backlog", () => {
    const r = transitionTask(make(), "assigned", { at: t1, actorId: ada });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.message).toMatch(/assignee/);
    const assigned = unwrap(
      transitionTask(make(), "assigned", { at: t1, actorId: ada, assigneeId: bob }),
    );
    expect(assigned.assigneeId).toBe(bob);
    const back = unwrap(transitionTask(assigned, "backlog", { at: t1, actorId: ada }));
    expect(back.assigneeId).toBeNull();
  });

  it("re-assigns when leaving transferred or escalated with a new assignee", () => {
    const transferred = walk(make({ assigneeId: ada }), ["transferred"]);
    const reassigned = unwrap(
      transitionTask(transferred, "assigned", { at: t1, actorId: bob, assigneeId: bob }),
    );
    expect(reassigned.assigneeId).toBe(bob);
  });

  it("does not mutate the input task", () => {
    const task = make({ assigneeId: ada });
    unwrap(transitionTask(task, "in_progress", { at: t1, actorId: ada }));
    expect(task.status).toBe("assigned");
    expect(task.history).toHaveLength(1);
  });
});

describe("ranking one priority against another", () => {
  it("ranks them in the order they are declared, lowest first", () => {
    const ranks = TASK_PRIORITIES.map((priority) => PRIORITY_RANK[priority]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("gives every priority a rank of its own", () => {
    expect(new Set(Object.values(PRIORITY_RANK)).size).toBe(TASK_PRIORITIES.length);
  });

  it("starts at zero, so a rank can be packed into a positional key", () => {
    expect(Math.min(...Object.values(PRIORITY_RANK))).toBe(0);
  });

  it("leaves room for no more than ten levels, which is what packing assumes", () => {
    expect(Math.max(...Object.values(PRIORITY_RANK))).toBeLessThan(10);
  });

  it("recognises a priority, and refuses anything else", () => {
    expect(isPriority("urgent")).toBe(true);
    expect(isPriority("URGENT")).toBe(false);
    expect(isPriority("")).toBe(false);
    expect(isPriority(3)).toBe(false);
    expect(isPriority(undefined)).toBe(false);
  });
});

describe("what is still on somebody's desk", () => {
  const withStatus = (id: string, assigneeId: string | null, status: TaskStatus): Task =>
    ({ id, assigneeId, status }) as Task;

  it("counts work that has not finished", () => {
    const counts = openTaskCounts([
      withStatus("t1", "emp-ada", "in_progress"),
      withStatus("t2", "emp-ada", "assigned"),
    ]);
    expect(counts["emp-ada"]).toBe(2);
  });

  it("does not count work that is over", () => {
    for (const status of TERMINAL_TASK_STATUSES) {
      expect(openTaskCounts([withStatus("t1", "emp-ada", status)])["emp-ada"] ?? 0, status).toBe(0);
    }
  });

  it("counts work that is stuck, since a blocked task is still theirs", () => {
    // Blocked is not finished: the person still owes an answer on it, and a
    // reviewer chosen because they look free would be chosen wrongly.
    expect(openTaskCounts([withStatus("t1", "emp-ada", "blocked")])["emp-ada"]).toBe(1);
  });

  it("counts work waiting on a review as still open for its author", () => {
    expect(openTaskCounts([withStatus("t1", "emp-ada", "in_review")])["emp-ada"]).toBe(1);
  });

  it("ignores work nobody is holding", () => {
    expect(openTaskCounts([withStatus("t1", null, "backlog")])).toEqual({});
  });

  it("keeps each person's count to themselves", () => {
    const counts = openTaskCounts([
      withStatus("t1", "emp-ada", "in_progress"),
      withStatus("t2", "emp-grace", "assigned"),
    ]);
    expect(counts).toEqual({ "emp-ada": 1, "emp-grace": 1 });
  });

  it("says nothing about somebody with nothing on", () => {
    expect(openTaskCounts([])["emp-ada"]).toBeUndefined();
  });
});

describe("the route a piece of work has taken", () => {
  const base = { officeId, departmentId, title: "Write the parser" };

  it("is empty for work that started here", () => {
    expect(unwrap(createTask(base, deps)).route).toEqual([]);
  });

  it("carries where the work has already been, when it was handed on", () => {
    const route = ["dept-product", "dept-design"] as DepartmentId[];
    expect(unwrap(createTask({ ...base, route }, deps)).route).toEqual(route);
  });

  it("refuses a route that is not a list of departments", () => {
    expect(isErr(createTask({ ...base, route: ["dept-a", 7] as never }, deps))).toBe(true);
  });

  it("starts with nothing to show for itself", () => {
    expect(unwrap(createTask(base, deps)).artifacts).toEqual([]);
  });

  it("can be handed the artifacts it is continuing from", () => {
    // A handoff carries the work; without this it could only carry a title.
    const artifacts = ["the wireframes", "the copy deck"];
    expect(unwrap(createTask({ ...base, artifacts }, deps)).artifacts).toEqual(artifacts);
  });

  it("refuses artifacts that are not text", () => {
    expect(isErr(createTask({ ...base, artifacts: [{}] as never }, deps))).toBe(true);
  });
});

describe("what would make this work acceptable", () => {
  const base = { officeId, departmentId, title: "Write the parser" };

  it("says nothing by default, which means the department decides", () => {
    expect(unwrap(createTask(base, deps)).acceptanceCriteria).toEqual([]);
  });

  it("takes a list of its own", () => {
    const criteria = ["handles malformed input", "has tests for the error path"];
    expect(
      unwrap(createTask({ ...base, acceptanceCriteria: criteria }, deps)).acceptanceCriteria,
    ).toEqual(criteria);
  });

  it("refuses a criterion that is not text", () => {
    expect(isErr(createTask({ ...base, acceptanceCriteria: [7] as never }, deps))).toBe(true);
  });

  it("refuses an empty criterion, which asks for nothing", () => {
    expect(isErr(createTask({ ...base, acceptanceCriteria: ["  "] }, deps))).toBe(true);
  });

  it("refuses a criterion too long to be one thing", () => {
    const rambling = "x".repeat(TASK_TITLE_MAX_LENGTH + 1);
    expect(isErr(createTask({ ...base, acceptanceCriteria: [rambling] }, deps))).toBe(true);
  });

  it("refuses the same criterion twice, which would be asked about twice", () => {
    const twice = ["has tests", "has tests"];
    expect(isErr(createTask({ ...base, acceptanceCriteria: twice }, deps))).toBe(true);
  });
});

describe("which departments have already signed this off", () => {
  const base = { officeId, departmentId, title: "Write the parser" };

  it("is nobody, for work that has been nowhere near a checker", () => {
    expect(unwrap(createTask(base, deps)).checkedBy).toEqual([]);
  });

  it("carries who has signed off, for work that is already part-way through", () => {
    const checked = ["dept-qa"] as DepartmentId[];
    expect(unwrap(createTask({ ...base, checkedBy: checked }, deps)).checkedBy).toEqual(checked);
  });

  it("refuses a signature that is not a department", () => {
    expect(isErr(createTask({ ...base, checkedBy: [7] as never }, deps))).toBe(true);
  });
});

describe("work approved here but not yet checked elsewhere", () => {
  it("may go back into review, for a department that checks this one's work", () => {
    expect(canTransition("approved", "in_review")).toBe(true);
  });

  it("may still simply finish, or hand on to the next stage", () => {
    expect(canTransition("approved", "done")).toBe(true);
    expect(canTransition("approved", "assigned")).toBe(true);
  });

  it("may not go back to being worked on directly", () => {
    expect(canTransition("approved", "in_progress")).toBe(false);
  });
});

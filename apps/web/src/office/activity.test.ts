import { describe, expect, it } from "vitest";
import type { EmployeeId, Task, TaskId, TaskStatus } from "@vo/core";
import { activityFromTasks, describeActivity, labelActivity } from "./activity.js";

const ada = "emp-ada" as EmployeeId;
const grace = "emp-grace" as EmployeeId;

const task = (status: TaskStatus, overrides: Partial<Task> = {}): Task =>
  ({
    id: `task-${status}` as TaskId,
    status,
    assigneeId: ada,
    reviewerIds: [],
    title: "Write the parser",
    ...overrides,
  }) as Task;

describe("what an employee is doing", () => {
  it("is working while their task is under way", () => {
    expect(activityFromTasks([task("in_progress")])[ada]).toBe("working");
  });

  it("is waiting while their work sits with a reviewer", () => {
    expect(activityFromTasks([task("in_review")])[ada]).toBe("waiting");
  });

  it("is waiting while their work is blocked on something else", () => {
    expect(activityFromTasks([task("blocked")])[ada]).toBe("waiting");
  });

  it("is in error when their work was escalated", () => {
    expect(activityFromTasks([task("escalated")])[ada]).toBe("error");
  });

  it("is idle with nothing on, and after the work is done", () => {
    expect(activityFromTasks([])[ada]).toBeUndefined();
    expect(activityFromTasks([task("done")])[ada]).toBeUndefined();
    expect(activityFromTasks([task("backlog")])[ada]).toBeUndefined();
  });

  it("puts the reviewer to work when something is waiting on them", () => {
    const activity = activityFromTasks([task("in_review", { reviewerIds: [grace] })]);
    expect(activity[grace]).toBe("working");
    // And the author is the one waiting.
    expect(activity[ada]).toBe("waiting");
  });

  it("shows the worst of somebody's tasks, since that is what needs attention", () => {
    const activity = activityFromTasks([
      task("in_progress", { id: "t1" as TaskId }),
      task("escalated", { id: "t2" as TaskId }),
    ]);
    expect(activity[ada]).toBe("error");
  });

  it("prefers working to waiting when somebody has both", () => {
    const activity = activityFromTasks([
      task("in_review", { id: "t1" as TaskId }),
      task("in_progress", { id: "t2" as TaskId }),
    ]);
    expect(activity[ada]).toBe("working");
  });

  it("ignores a task nobody is assigned to", () => {
    expect(activityFromTasks([task("in_progress", { assigneeId: null })])).toEqual({});
  });
});

describe("saying it in words", () => {
  it("keeps the chip to one short word, so it fits under a figure", () => {
    for (const state of ["working", "waiting", "error", "idle"] as const) {
      expect(labelActivity(state).split(" ")).toHaveLength(1);
    }
  });

  it("names each state for the people who cannot see colour", () => {
    expect(describeActivity("working")).toMatch(/working/i);
    expect(describeActivity("waiting")).toMatch(/waiting/i);
    expect(describeActivity("error")).toMatch(/attention|error|wrong/i);
    expect(describeActivity("idle")).toMatch(/nothing|idle/i);
  });
});

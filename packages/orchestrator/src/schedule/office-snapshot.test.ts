import { describe, expect, it } from "vitest";
import {
  createDepartment,
  createEmployee,
  createTask,
  unwrap,
  type DepartmentId,
  type EmployeeId,
  type OfficeId,
  type TaskId,
} from "@vo/core";
import { officeSnapshot } from "./office-snapshot.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");

const office = unwrap(
  (await import("@vo/core")).createOffice({ name: "Acme" }, { id: () => officeId, now: () => at }),
);
const eng = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-eng" as DepartmentId,
      now: () => at,
    },
  ),
);
const ada = unwrap(
  createEmployee(
    {
      name: "Ada",
      role: "Engineer",
      color: "#00aa66",
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
    },
    { department: { id: eng.id, officeId }, supervisor: null },
    { id: () => "emp-ada" as EmployeeId, now: () => at },
  ),
);
const task = unwrap(
  createTask(
    { officeId, departmentId: eng.id, title: "Write the parser", assigneeId: ada.id },
    { id: () => "task-1" as TaskId, now: () => at },
  ),
);

describe("turning an office into something the scheduler can read", () => {
  const snapshot = officeSnapshot({
    office,
    departments: [eng],
    employees: [ada],
    tasks: [task],
  });

  it("carries the office's hours, which gate everything else", () => {
    expect(snapshot.offices).toEqual([{ id: officeId, schedule: office.schedule }]);
  });

  it("carries each department with its own hours", () => {
    expect(snapshot.departments[0]).toMatchObject({ id: eng.id, officeId, schedule: eng.schedule });
  });

  it("carries each employee with their status, since a paused one is skipped", () => {
    expect(snapshot.employees[0]).toMatchObject({ id: ada.id, status: "active" });
  });

  it("gives an employee with no hours of their own the office's", () => {
    expect(snapshot.employees[0]?.schedule).toEqual({ kind: "always" });
  });

  it("carries each task with who it is for and who owes it a review", () => {
    expect(snapshot.tasks[0]).toMatchObject({
      id: task.id,
      assigneeId: ada.id,
      status: "assigned",
      reviewerIds: [],
    });
  });

  it("counts a task's revision from its history, not from a clock", () => {
    expect(snapshot.tasks[0]?.revision).toBe(task.history.length);
  });

  it("has no recurring work unless it was given some", () => {
    expect(snapshot.recurring).toEqual([]);
  });
});

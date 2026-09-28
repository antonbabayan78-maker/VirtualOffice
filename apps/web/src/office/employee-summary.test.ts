import { describe, expect, it } from "vitest";
import {
  createDepartment,
  createEmployee,
  createTask,
  unwrap,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Task,
  type TaskId,
} from "@vo/core";
import { summariseEmployee } from "./employee-summary.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");
const eng: Department = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-eng" as DepartmentId,
      now: () => at,
    },
  ),
);

const person = (
  id: string,
  name: string,
  role: string,
  supervisor: Employee | null = null,
): Employee =>
  unwrap(
    createEmployee(
      {
        name,
        role,
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
        ...(supervisor === null ? {} : { supervisorId: supervisor.id }),
      },
      { department: { id: eng.id, officeId }, supervisor },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

const grace = person("emp-grace", "Grace", "Engineering manager");
const ada = person("emp-ada", "Ada", "Backend engineer", grace);

const task = (title: string, status: Task["status"]): Task => ({
  ...unwrap(
    createTask(
      { officeId, departmentId: eng.id, title, assigneeId: ada.id },
      {
        id: () => "task-1" as TaskId,
        now: () => at,
      },
    ),
  ),
  status,
});

const summary = (tasks: readonly Task[] = []) =>
  summariseEmployee(ada, { department: eng, employees: [grace, ada], tasks, activity: "idle" });

describe("what to say about somebody when you point at them", () => {
  it("gives their name and what they are employed to do", () => {
    expect(summary()).toMatchObject({ name: "Ada", role: "Backend engineer" });
  });

  it("names the department they sit in", () => {
    expect(summary().department).toBe("Engineering");
  });

  it("names the model doing the thinking, since that is what it costs", () => {
    expect(summary().model).toBe("claude-sonnet-5");
  });

  it("names who they answer to", () => {
    expect(summary().reportsTo).toBe("Grace");
  });

  it("says nobody when they answer to nobody", () => {
    const boss = summariseEmployee(grace, {
      department: eng,
      employees: [grace, ada],
      tasks: [],
      activity: "idle",
    });
    expect(boss.reportsTo).toBeNull();
  });

  it("says plainly when there is nothing on, rather than a sentence fragment", () => {
    expect(summary().activity).toMatch(/nothing/i);
  });

  it("says what they are doing right now in words", () => {
    const busy = summariseEmployee(ada, {
      department: eng,
      employees: [grace, ada],
      tasks: [],
      activity: "working",
    });
    expect(busy.activity).toMatch(/working/i);
  });

  it("names the task they are on, so it is not merely 'working'", () => {
    expect(summary([task("Rewrite the query planner", "in_progress")]).task).toBe(
      "Rewrite the query planner",
    );
  });

  it("ignores work that is finished when saying what they are on", () => {
    expect(summary([task("Rewrite the query planner", "done")]).task).toBeNull();
  });

  it("counts everything still on their desk, not only the one showing", () => {
    const open = [
      task("Rewrite the query planner", "in_progress"),
      { ...task("Cache the dashboard", "assigned"), id: "task-2" as TaskId },
      { ...task("Old news", "done"), id: "task-3" as TaskId },
    ];
    expect(summary(open).openTasks).toBe(2);
  });

  it("lists their skills, which is what they were hired for", () => {
    const skilled = summariseEmployee(
      { ...ada, skillIds: ["sql", "code-review"] as never },
      { department: eng, employees: [grace, ada], tasks: [], activity: "idle" },
    );
    expect(skilled.skills).toEqual(["sql", "code-review"]);
  });
});

import { describe, expect, it } from "vitest";
import {
  createDepartment,
  createEmployee,
  createTask,
  setRunState,
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
    expect(snapshot.offices).toEqual([
      {
        id: officeId,
        schedule: office.schedule,
        runState: "running",
        budget: null,
        spentUsd: 0,
        priority: "normal",
      },
    ]);
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

describe("carrying the standing priorities through", () => {
  it("carries the office's, so the organisation's decision reaches the queue", () => {
    const snapshot = officeSnapshot({
      office: { ...office, priority: "high" },
      departments: [eng],
      employees: [ada],
      tasks: [task],
    });
    expect(snapshot.offices[0]?.priority).toBe("high");
  });

  it("carries each department's", () => {
    const snapshot = officeSnapshot({
      office,
      departments: [{ ...eng, priority: "urgent" }],
      employees: [ada],
      tasks: [task],
    });
    expect(snapshot.departments[0]?.priority).toBe("urgent");
  });

  it("carries each employee's", () => {
    const snapshot = officeSnapshot({
      office,
      departments: [eng],
      employees: [{ ...ada, priority: "low" }],
      tasks: [task],
    });
    expect(snapshot.employees[0]?.priority).toBe("low");
  });
});

describe("carrying a stopped office through to the scheduler", () => {
  const input = { office, departments: [eng], employees: [ada], tasks: [task] };

  it("passes the office's switch on", () => {
    const stopped = setRunState(office, "paused");
    expect(officeSnapshot({ ...input, office: stopped }).offices[0]?.runState).toBe("paused");
  });

  it("passes a department's switch on", () => {
    const stopped = setRunState(eng, "paused");
    expect(officeSnapshot({ ...input, departments: [stopped] }).departments[0]?.runState).toBe(
      "paused",
    );
  });

  it("says running for an office that is", () => {
    // The scheduler treats an absent switch as running, but there is no reason
    // to leave it out when the office has an answer.
    expect(officeSnapshot(input).offices[0]?.runState).toBe("running");
  });
});

describe("carrying budgets and what has been spent to the scheduler", () => {
  const capped = { limitUsd: 10, warnAtUsd: 8, period: "day" as const };
  const input = { office, departments: [eng], employees: [ada], tasks: [task] };

  it("passes each level's budget on", () => {
    const snapshot = officeSnapshot({
      ...input,
      office: { ...office, budget: capped },
      departments: [{ ...eng, budget: capped }],
      employees: [{ ...ada, budget: capped }],
    });

    expect(snapshot.offices[0]?.budget).toEqual(capped);
    expect(snapshot.departments[0]?.budget).toEqual(capped);
    expect(snapshot.employees[0]?.budget).toEqual(capped);
  });

  it("passes what each level has spent on", () => {
    const snapshot = officeSnapshot({
      ...input,
      spend: {
        officeUsd: 4,
        byDepartment: { [eng.id]: 3 },
        byEmployee: { [ada.id]: 2 },
      },
    });

    expect(snapshot.offices[0]?.spentUsd).toBe(4);
    expect(snapshot.departments[0]?.spentUsd).toBe(3);
    expect(snapshot.employees[0]?.spentUsd).toBe(2);
  });

  it("says nothing spent for a level the summary does not mention", () => {
    const snapshot = officeSnapshot({
      ...input,
      spend: { officeUsd: 4, byDepartment: {}, byEmployee: {} },
    });
    expect(snapshot.departments[0]?.spentUsd).toBe(0);
    expect(snapshot.employees[0]?.spentUsd).toBe(0);
  });

  it("says nothing spent when no summary was given at all", () => {
    // An office whose spend could not be read schedules as it always did.
    const snapshot = officeSnapshot(input);
    expect(snapshot.offices[0]?.spentUsd).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { Department, Employee, Task, UsageRecord } from "@vo/core";
import { asCsv, usageReport, type UsageFilter } from "./usage-report.js";

const at = (iso: string) => new Date(iso);

const row = (
  id: string,
  employeeId: string | null,
  usd: number | null,
  overrides: Partial<UsageRecord> & { model?: string; ms?: number } = {},
): UsageRecord =>
  ({
    id,
    officeId: "office-1",
    taskId: overrides.taskId ?? "task-1",
    employeeId,
    at: overrides.at ?? at("2026-10-01T09:00:00Z"),
    event: {
      kind: "llm_call",
      model: overrides.model ?? "claude-sonnet-5",
      durationMs: overrides.ms ?? 1000,
      cost: usd === null ? null : { totalUsd: usd },
    },
  }) as unknown as UsageRecord;

const person = (id: string, name: string, departmentId: string, model: string): Employee =>
  ({ id, name, departmentId, llm: { model } }) as unknown as Employee;

const room = (id: string, name: string): Department => ({ id, name }) as unknown as Department;

const task = (id: string, status: string, departmentId = "dept-design"): Task =>
  ({ id, status, departmentId, title: `Task ${id}` }) as unknown as Task;

const office = {
  departments: [room("dept-design", "Design"), room("dept-eng", "Engineering")],
  employees: [
    person("emp-iris", "Iris", "dept-design", "claude-sonnet-5"),
    person("emp-theo", "Theo", "dept-design", "claude-opus-5"),
    person("emp-ada", "Ada", "dept-eng", "claude-sonnet-5"),
  ],
  tasks: [task("task-1", "done"), task("task-2", "in_progress")],
};

const report = (usage: readonly UsageRecord[], filter: UsageFilter = {}) =>
  usageReport({ ...office, usage, filter });

describe("what the office has spent", () => {
  it("is nothing when nothing has been spent", () => {
    const totals = report([]);
    expect(totals.totalUsd).toBe(0);
    expect(totals.calls).toBe(0);
  });

  it("adds up every priced call", () => {
    expect(report([row("u1", "emp-iris", 1.5), row("u2", "emp-theo", 2.25)]).totalUsd).toBeCloseTo(
      3.75,
    );
  });

  it("counts a call nobody could price without adding it as free", () => {
    // A model the registry has no price for must not make a total look smaller
    // than it is; the total says it is a floor instead.
    const totals = report([row("u1", "emp-iris", 1), row("u2", "emp-iris", null)]);
    expect(totals.totalUsd).toBeCloseTo(1);
    expect(totals.unpricedCalls).toBe(1);
    expect(totals.calls).toBe(2);
  });
});

describe("where the money went", () => {
  const usage = [
    row("u1", "emp-iris", 1, { model: "claude-sonnet-5" }),
    row("u2", "emp-iris", 2, { model: "claude-sonnet-5" }),
    row("u3", "emp-theo", 4, { model: "claude-opus-5" }),
    row("u4", "emp-ada", 0.5, { model: "claude-sonnet-5" }),
  ];

  it("splits by person, biggest first", () => {
    const rows = report(usage).byEmployee;
    expect(rows.map((one) => one.name)).toEqual(["Theo", "Iris", "Ada"]);
    expect(rows[0]?.usd).toBeCloseTo(4);
  });

  it("says which model each person runs, since that is what is being compared", () => {
    expect(report(usage).byEmployee[0]?.detail).toBe("claude-opus-5");
  });

  it("splits by department, through the people in it", () => {
    const rows = report(usage).byDepartment;
    expect(rows.find((one) => one.name === "Design")?.usd).toBeCloseTo(7);
    expect(rows.find((one) => one.name === "Engineering")?.usd).toBeCloseTo(0.5);
  });

  it("splits by model, which is the question a dashboard is opened to answer", () => {
    const rows = report(usage).byModel;
    expect(rows.find((one) => one.name === "claude-opus-5")?.usd).toBeCloseTo(4);
    expect(rows.find((one) => one.name === "claude-sonnet-5")?.usd).toBeCloseTo(3.5);
  });

  it("counts a breakdown row's unpriced calls, so no row can look free", () => {
    // A model the registry cannot price would otherwise appear as "$0.00",
    // which reads as "this one costs nothing" — the opposite of the truth and
    // the exact mistake the total is careful not to make.
    const rows = report([row("u1", "emp-iris", null, { model: "something-new" })]).byModel;
    expect(rows[0]?.unpricedCalls).toBe(1);
    expect(rows[0]?.usd).toBe(0);
  });

  it("counts them per person too", () => {
    const rows = report([row("u1", "emp-iris", null)]).byEmployee;
    expect(rows[0]?.unpricedCalls).toBe(1);
  });

  it("says a row is fully priced when it is", () => {
    expect(report([row("u1", "emp-iris", 1)]).byEmployee[0]?.unpricedCalls).toBe(0);
  });

  it("names somebody who has left rather than showing a bare id", () => {
    expect(report([row("u1", "emp-gone", 1)]).byEmployee[0]?.name).toMatch(/left|unknown/i);
  });

  it("does not lose a call nobody is attributed for", () => {
    const totals = report([row("u1", null, 3)]);
    expect(totals.totalUsd).toBeCloseTo(3);
    expect(totals.byEmployee).toEqual([]);
  });
});

describe("what a finished piece of work cost", () => {
  it("counts only work that is actually finished", () => {
    const usage = [
      row("u1", "emp-iris", 2, { taskId: "task-1" as never }),
      row("u2", "emp-iris", 8, { taskId: "task-2" as never }),
    ];
    const totals = report(usage);

    expect(totals.completedTasks).toBe(1);
    expect(totals.usdPerCompletedTask).toBeCloseTo(2);
  });

  it("says nothing rather than dividing by no finished work", () => {
    const totals = report([row("u1", "emp-iris", 8, { taskId: "task-2" as never })], {});
    expect(totals.completedTasks).toBe(0);
    expect(totals.usdPerCompletedTask).toBeNull();
  });
});

describe("narrowing what is shown", () => {
  const usage = [
    row("u1", "emp-iris", 1, { at: at("2026-09-30T09:00:00Z") }),
    row("u2", "emp-iris", 2, { at: at("2026-10-01T09:00:00Z") }),
    row("u3", "emp-ada", 4, { at: at("2026-10-01T10:00:00Z") }),
  ];

  it("shows everything by default", () => {
    expect(report(usage).totalUsd).toBeCloseTo(7);
  });

  it("narrows to one department", () => {
    expect(report(usage, { departmentId: "dept-eng" }).totalUsd).toBeCloseTo(4);
  });

  it("narrows to what happened since a moment", () => {
    expect(report(usage, { since: at("2026-10-01T00:00:00Z") }).totalUsd).toBeCloseTo(6);
  });

  it("narrows by both at once", () => {
    const filter: UsageFilter = { departmentId: "dept-design", since: at("2026-10-01T00:00:00Z") };
    expect(report(usage, filter).totalUsd).toBeCloseTo(2);
  });

  it("leaves a department with nothing spent showing nothing, not everything", () => {
    expect(report(usage, { departmentId: "dept-nobody" }).totalUsd).toBe(0);
  });
});

describe("taking the figures away", () => {
  it("writes a row per call, with a header", () => {
    const csv = asCsv(report([row("u1", "emp-iris", 1.5)]));
    const lines = csv.trim().split("\n");

    expect(lines[0]).toContain("when");
    expect(lines[0]).toContain("cost_usd");
    expect(lines).toHaveLength(2);
  });

  it("names the person and the model, not only their ids", () => {
    expect(asCsv(report([row("u1", "emp-iris", 1.5)]))).toContain("Iris");
    expect(asCsv(report([row("u1", "emp-iris", 1.5)]))).toContain("claude-sonnet-5");
  });

  it("leaves an unpriced call's cost empty rather than writing a zero", () => {
    const line =
      asCsv(report([row("u1", "emp-iris", null)]))
        .trim()
        .split("\n")[1] ?? "";
    expect(line.endsWith(",")).toBe(true);
  });

  it("quotes a name that would otherwise break the columns", () => {
    const withComma = {
      ...office,
      employees: [person("emp-iris", 'Iris, "the fast one"', "dept-design", "m")],
    };
    const csv = asCsv(usageReport({ ...withComma, usage: [row("u1", "emp-iris", 1)], filter: {} }));

    expect(csv).toContain('"Iris, ""the fast one"""');
  });

  it("writes only what the filter left", () => {
    const usage = [row("u1", "emp-iris", 1), row("u2", "emp-ada", 2)];
    const csv = asCsv(report(usage, { departmentId: "dept-eng" }));

    expect(csv).toContain("Ada");
    expect(csv).not.toContain("Iris");
  });
});

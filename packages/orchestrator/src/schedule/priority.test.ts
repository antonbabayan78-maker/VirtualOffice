import { describe, expect, it } from "vitest";
import { TASK_PRIORITIES, type TaskPriority } from "@vo/core";
import { orderingKey, type PriorityLevels } from "./priority.js";

const levels = (overrides: Partial<PriorityLevels> = {}): PriorityLevels => ({
  office: "normal",
  department: "normal",
  employee: "normal",
  task: "normal",
  ...overrides,
});

/** Sorts highest-first, the way the queue claims. */
const order = (entries: readonly (readonly [string, PriorityLevels])[]): string[] =>
  [...entries].sort(([, a], [, b]) => orderingKey(b) - orderingKey(a)).map(([name]) => name);

describe("turning four levels into one number the queue can sort by", () => {
  it("gives an office that has set nothing the same key as before there were levels", () => {
    // Every level normal: the key is a constant, so ordering falls through to
    // whatever the queue does with ties, exactly as it did.
    expect(orderingKey(levels())).toBe(orderingKey(levels()));
  });

  it("orders by the task when nothing above it has an opinion", () => {
    expect(
      order([
        ["low", levels({ task: "low" })],
        ["urgent", levels({ task: "urgent" })],
        ["normal", levels({ task: "normal" })],
      ]),
    ).toEqual(["urgent", "normal", "low"]);
  });

  it("lets a department outrank another department's task, however urgent", () => {
    expect(
      order([
        ["crunched department, trivial task", levels({ department: "urgent", task: "low" })],
        ["ordinary department, urgent task", levels({ department: "normal", task: "urgent" })],
      ]),
    ).toEqual(["crunched department, trivial task", "ordinary department, urgent task"]);
  });

  it("still orders a department's own work by task priority", () => {
    expect(
      order([
        ["theirs, low", levels({ department: "urgent", task: "low" })],
        ["theirs, urgent", levels({ department: "urgent", task: "urgent" })],
      ]),
    ).toEqual(["theirs, urgent", "theirs, low"]);
  });

  it("lets the organisation outrank a department, however high the department sets itself", () => {
    expect(
      order([
        [
          "that office",
          levels({ office: "high", department: "low", employee: "low", task: "low" }),
        ],
        [
          "this department",
          levels({ office: "normal", department: "urgent", employee: "urgent", task: "urgent" }),
        ],
      ]),
    ).toEqual(["that office", "this department"]);
  });

  it("lets a department outrank an employee, however high the employee sets themselves", () => {
    expect(
      order([
        ["that department", levels({ department: "high", employee: "low", task: "low" })],
        ["this employee", levels({ department: "normal", employee: "urgent", task: "urgent" })],
      ]),
    ).toEqual(["that department", "this employee"]);
  });

  it("lets an employee outrank a task, however urgent the task", () => {
    expect(
      order([
        ["that person", levels({ employee: "high", task: "low" })],
        ["this task", levels({ employee: "normal", task: "urgent" })],
      ]),
    ).toEqual(["that person", "this task"]);
  });

  it("gives two identical sets of levels the same key, so arrival order decides", () => {
    expect(orderingKey(levels({ department: "high" }))).toBe(
      orderingKey(levels({ department: "high" })),
    );
  });

  it("never lets a lower level reach the next level up, whatever it is set to", () => {
    const highest = (level: keyof PriorityLevels): number =>
      Math.max(...TASK_PRIORITIES.map((p) => orderingKey(levels({ [level]: p }))));
    const lowest = (level: keyof PriorityLevels): number =>
      Math.min(...TASK_PRIORITIES.map((p) => orderingKey(levels({ [level]: p }))));

    // Everything an employee can do stays inside the gap between two department
    // steps; the same one level down. This is what makes the order strict.
    expect(highest("task") - lowest("task")).toBeLessThan(
      orderingKey(levels({ employee: "normal" })) - orderingKey(levels({ employee: "low" })),
    );
    expect(highest("employee") - lowest("employee")).toBeLessThan(
      orderingKey(levels({ department: "normal" })) - orderingKey(levels({ department: "low" })),
    );
    expect(highest("department") - lowest("department")).toBeLessThan(
      orderingKey(levels({ office: "normal" })) - orderingKey(levels({ office: "low" })),
    );
  });

  it("stays a whole number, since a queue sorts by a plain number", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(Number.isInteger(orderingKey(levels({ office: priority })))).toBe(true);
    }
  });

  it("stays readable in a log: one digit per level, highest level first", () => {
    const key = orderingKey({
      office: "urgent",
      department: "high",
      employee: "normal",
      task: "low",
    } satisfies Record<keyof PriorityLevels, TaskPriority>);
    expect(String(key)).toBe("3210");
  });
});

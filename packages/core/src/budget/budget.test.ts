import { describe, expect, it } from "vitest";
import { createDepartment, type DepartmentId } from "../department/department.js";
import { createEmployee, type EmployeeId } from "../employee/employee.js";
import { createOffice, updateOffice, type OfficeId } from "../office/office.js";
import { isErr, unwrap } from "../shared/result.js";
import {
  BUDGET_PERIODS,
  budgetStanding,
  parseBudget,
  periodStart,
  spentSince,
  type Budget,
} from "./budget.js";

const budget = (overrides: Partial<Budget> = {}): Budget => ({
  limitUsd: 10,
  warnAtUsd: 8,
  period: "day",
  ...overrides,
});

describe("the periods a budget can cover", () => {
  it("names them", () => {
    expect(BUDGET_PERIODS).toEqual(["day", "month"]);
  });
});

describe("how a level is standing against its budget", () => {
  it("is fine with no budget at all, whatever has been spent", () => {
    expect(budgetStanding(null, 9999)).toBe("ok");
  });

  it("is fine below the warning", () => {
    expect(budgetStanding(budget(), 7.99)).toBe("ok");
  });

  it("warns at the warning", () => {
    expect(budgetStanding(budget(), 8)).toBe("warn");
  });

  it("stays warning between the warning and the limit", () => {
    expect(budgetStanding(budget(), 9.99)).toBe("warn");
  });

  it("is over at the limit, not a penny past it", () => {
    // A limit of $10 that allowed $10.00 and stopped at $10.01 would be a
    // limit nobody could state out loud.
    expect(budgetStanding(budget(), 10)).toBe("over");
  });

  it("is over past the limit", () => {
    expect(budgetStanding(budget(), 40)).toBe("over");
  });

  it("warns only at the limit when no warning was set", () => {
    const noWarning = budget({ warnAtUsd: null });
    expect(budgetStanding(noWarning, 9.99)).toBe("ok");
    expect(budgetStanding(noWarning, 10)).toBe("over");
  });

  it("treats a warning above the limit as no warning at all", () => {
    // Refused when it is set, but an office file written before that rule
    // existed must not make the limit unreachable.
    expect(budgetStanding(budget({ warnAtUsd: 20 }), 10)).toBe("over");
  });
});

describe("when a period began", () => {
  const at = new Date("2026-10-01T09:30:00Z");

  it("starts a day at midnight where the office is", () => {
    // Nicosia is UTC+3 in October, so its day began at 21:00 UTC yesterday.
    expect(periodStart("day", at, "Asia/Nicosia").toISOString()).toBe("2026-09-30T21:00:00.000Z");
  });

  it("starts a day at UTC midnight for an office that keeps no hours", () => {
    expect(periodStart("day", at, "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("starts a month on the first, where the office is", () => {
    expect(periodStart("month", at, "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("starts the month before when the office's month has not turned yet", () => {
    // 2026-10-01T00:30 UTC is still 30 September in New York.
    const justAfterUtcMidnight = new Date("2026-10-01T00:30:00Z");
    expect(periodStart("month", justAfterUtcMidnight, "America/New_York").toISOString()).toBe(
      "2026-09-01T04:00:00.000Z",
    );
  });

  it("falls back to UTC rather than throwing on a zone nobody has heard of", () => {
    // An office file can carry anything; a budget that threw here would take
    // the whole tick down with it.
    expect(periodStart("day", at, "Mars/Olympus").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("what has been spent since a period began", () => {
  const rows = [
    { at: new Date("2026-10-01T08:00:00Z"), usd: 1.5 },
    { at: new Date("2026-10-01T09:00:00Z"), usd: 2 },
    { at: new Date("2026-09-30T23:00:00Z"), usd: 100 },
  ];

  it("adds up what falls inside", () => {
    expect(spentSince(rows, new Date("2026-10-01T00:00:00Z"))).toBe(3.5);
  });

  it("leaves out what came before", () => {
    // The whole point of a period: yesterday's spending is not today's.
    expect(spentSince(rows, new Date("2026-10-01T00:00:00Z"))).not.toBeCloseTo(103.5);
  });

  it("counts a row exactly on the boundary as inside", () => {
    expect(
      spentSince(
        [{ at: new Date("2026-10-01T00:00:00Z"), usd: 5 }],
        new Date("2026-10-01T00:00:00Z"),
      ),
    ).toBe(5);
  });

  it("is nothing when nothing has been spent", () => {
    expect(spentSince([], new Date("2026-10-01T00:00:00Z"))).toBe(0);
  });
});

describe("a budget as an office file or a route states it", () => {
  it("reads one", () => {
    expect(unwrap(parseBudget({ limitUsd: 10, warnAtUsd: 8, period: "day" }))).toEqual(budget());
  });

  it("takes one with no warning", () => {
    expect(unwrap(parseBudget({ limitUsd: 10, period: "month" }))).toEqual({
      limitUsd: 10,
      warnAtUsd: null,
      period: "month",
    });
  });

  it("takes nothing at all, which is an office with no budget", () => {
    expect(unwrap(parseBudget(undefined))).toBeNull();
    expect(unwrap(parseBudget(null))).toBeNull();
  });

  it("refuses a limit that is not money", () => {
    expect(isErr(parseBudget({ limitUsd: "ten", period: "day" }))).toBe(true);
    expect(isErr(parseBudget({ period: "day" }))).toBe(true);
  });

  it("refuses a limit of nothing, which would stop all work for ever", () => {
    expect(isErr(parseBudget({ limitUsd: 0, period: "day" }))).toBe(true);
    expect(isErr(parseBudget({ limitUsd: -5, period: "day" }))).toBe(true);
  });

  it("refuses a period nobody has heard of", () => {
    expect(isErr(parseBudget({ limitUsd: 10, period: "fortnight" }))).toBe(true);
  });

  it("refuses a warning above the limit, which would never fire", () => {
    expect(isErr(parseBudget({ limitUsd: 10, warnAtUsd: 12, period: "day" }))).toBe(true);
  });

  it("allows a warning exactly at the limit, which fires with the stop", () => {
    expect(isErr(parseBudget({ limitUsd: 10, warnAtUsd: 10, period: "day" }))).toBe(false);
  });

  it("says which field it refused", () => {
    const result = parseBudget({ limitUsd: 10, warnAtUsd: 12, period: "day" });
    expect(isErr(result) && result.error[0]?.path).toContain("warnAtUsd");
  });
});

describe("a budget on each level of the office", () => {
  const spend = { limitUsd: 10, warnAtUsd: 8, period: "day" as const };
  const officeId = "office-1" as OfficeId;
  const now = new Date("2026-10-01T00:00:00Z");
  const deps = { id: () => "x", now: () => now };

  it("an office has none until it is given one", () => {
    expect(
      unwrap(createOffice({ name: "Acme" }, { ...deps, id: () => officeId })).budget,
    ).toBeNull();
  });

  it("an office takes one, and keeps it through an unrelated change", () => {
    const acme = unwrap(
      createOffice({ name: "Acme", budget: spend }, { ...deps, id: () => officeId }),
    );
    expect(acme.budget).toEqual(spend);
    expect(unwrap(updateOffice(acme, { name: "Northwind" })).budget).toEqual(spend);
  });

  it("an office can have its budget taken away", () => {
    const acme = unwrap(
      createOffice({ name: "Acme", budget: spend }, { ...deps, id: () => officeId }),
    );
    expect(unwrap(updateOffice(acme, { budget: null })).budget).toBeNull();
  });

  it("refuses a budget the office would not accept", () => {
    expect(
      isErr(createOffice({ name: "Acme", budget: { limitUsd: -1, period: "day" } }, deps as never)),
    ).toBe(true);
  });

  it("a department has one of its own", () => {
    const design = unwrap(
      createDepartment(
        { officeId, name: "Design", color: "#7c5cff", position: { x: 0, y: 0 }, budget: spend },
        [],
        { id: () => "dept-1" as DepartmentId, now: () => now },
      ),
    );
    expect(design.budget).toEqual(spend);
  });

  it("a person has one of their own", () => {
    const iris = unwrap(
      createEmployee(
        {
          name: "Iris",
          role: "Designer",
          color: "#00aa66",
          llm: { provider: "anthropic", model: "claude-sonnet-5" },
          budget: spend,
        },
        { department: { id: "dept-1" as DepartmentId, officeId }, supervisor: null },
        { id: () => "emp-1" as EmployeeId, now: () => now },
      ),
    );
    expect(iris.budget).toEqual(spend);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  type UsageRecord,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { UsageScreen } from "./UsageScreen.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-10-01T09:00:00Z");

const design: Department = unwrap(
  createDepartment({ officeId, name: "Design", color: "#7c5cff", position: { x: 0, y: 0 } }, [], {
    id: () => "dept-design" as DepartmentId,
    now: () => at,
  }),
);
const engineering: Department = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    {
      id: () => "dept-eng" as DepartmentId,
      now: () => at,
    },
  ),
);

const person = (id: string, name: string, departmentId: DepartmentId, model: string): Employee =>
  unwrap(
    createEmployee(
      { name, role: "Maker", color: "#00aa66", llm: { provider: "anthropic", model } },
      { department: { id: departmentId, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

const iris = person("emp-iris", "Iris", design.id, "claude-sonnet-5");
const theo = person("emp-theo", "Theo", design.id, "claude-opus-5");
const ada = person("emp-ada", "Ada", engineering.id, "claude-sonnet-5");

const work = (id: string, departmentId: DepartmentId): Task =>
  unwrap(
    createTask(
      { officeId, departmentId, title: `Work ${id}` },
      {
        id: () => id as TaskId,
        now: () => at,
      },
    ),
  );

const spend = (id: string, employeeId: string, usd: number | null, when = at): UsageRecord =>
  ({
    id,
    officeId,
    taskId: "task-1",
    employeeId,
    at: when,
    event: {
      kind: "llm_call",
      model: employeeId === theo.id ? "claude-opus-5" : "claude-sonnet-5",
      durationMs: 1200,
      cost: usd === null ? null : { totalUsd: usd },
    },
  }) as unknown as UsageRecord;

let store: OfficeStore;

function open(usage: readonly UsageRecord[] = []) {
  cleanup();
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([design, engineering], [iris, theo, ada], [work("task-1", design.id)], []);
  store.getState().loadUsage(usage);
  return render(<UsageScreen store={store} />);
}

const totals = () => screen.getByRole("group", { name: /what this office has spent/i });

beforeEach(() => {
  open();
});

describe("an office that has spent nothing", () => {
  it("says so, rather than showing a page of zeroes", () => {
    expect(screen.getByRole("heading", { name: /usage/i })).toBeTruthy();
    expect(totals()).toHaveTextContent(/nothing yet|no calls/i);
  });

  it("does not offer to export an empty spreadsheet", () => {
    expect(screen.getByRole("button", { name: /export/i })).toBeDisabled();
  });
});

describe("what the office has spent", () => {
  const usage = [
    spend("u1", iris.id, 1),
    spend("u2", iris.id, 2),
    spend("u3", theo.id, 4),
    spend("u4", ada.id, 0.5),
  ];

  it("shows the total", () => {
    open(usage);
    expect(totals()).toHaveTextContent("$7.50");
  });

  it("shows how many calls it covers", () => {
    open(usage);
    expect(totals()).toHaveTextContent(/4 calls/i);
  });

  it("says when some of it could not be priced, so the total is read as a floor", () => {
    open([...usage, spend("u5", iris.id, null)]);
    expect(totals()).toHaveTextContent(/1 call|unpriced/i);
  });

  it("says nothing about unpriced calls when there are none", () => {
    open(usage);
    expect(totals()).not.toHaveTextContent(/unpriced/i);
  });
});

describe("where the money went", () => {
  const usage = [spend("u1", iris.id, 1), spend("u2", theo.id, 4), spend("u3", ada.id, 0.5)];

  it("breaks it down by person, with the model each one runs", () => {
    open(usage);
    const panel = screen.getByRole("group", { name: /by person/i });

    expect(panel).toHaveTextContent("Theo");
    expect(panel).toHaveTextContent("claude-opus-5");
  });

  it("puts the biggest first, so the first row answers the question", () => {
    open(usage);
    const rows = within(screen.getByRole("group", { name: /by person/i })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Theo");
  });

  it("breaks it down by department", () => {
    open(usage);
    expect(screen.getByRole("group", { name: /by department/i })).toHaveTextContent("Design");
  });

  it("breaks it down by model, which is what a dashboard is opened to answer", () => {
    open(usage);
    const panel = screen.getByRole("group", { name: /by model/i });
    expect(panel).toHaveTextContent("claude-opus-5");
    expect(panel).toHaveTextContent("claude-sonnet-5");
  });

  it("draws each row in proportion, so the split is visible without reading", () => {
    open(usage);
    const bars = within(screen.getByRole("group", { name: /by person/i })).getAllByRole("meter");
    expect(bars[0]).toHaveAttribute("aria-valuenow");
  });
});

describe("narrowing it down", () => {
  const usage = [
    spend("u1", iris.id, 1, new Date("2026-09-20T09:00:00Z")),
    spend("u2", iris.id, 2),
    spend("u3", ada.id, 4),
  ];

  it("narrows to one department", async () => {
    open(usage);
    await userEvent.setup().selectOptions(screen.getByLabelText("Department"), "dept-eng");

    expect(totals()).toHaveTextContent("$4.00");
  });

  it("goes back to everything", async () => {
    open(usage);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Department"), "dept-eng");
    await user.selectOptions(screen.getByLabelText("Department"), "");

    expect(totals()).toHaveTextContent("$7.00");
  });

  it("offers the office's own departments, not free text", () => {
    open(usage);
    const choices = within(screen.getByLabelText("Department")).getAllByRole("option");
    expect(choices.map((one) => one.textContent)).toEqual([
      "Every department",
      "Design",
      "Engineering",
    ]);
  });
});

describe("taking the figures away", () => {
  it("offers an export once there is something to export", () => {
    open([spend("u1", iris.id, 1)]);
    expect(screen.getByRole("button", { name: /export/i })).not.toBeDisabled();
  });

  it("hands the browser a file rather than a link carrying a token", async () => {
    const saved: { name: string; body: string }[] = [];
    open([spend("u1", iris.id, 1)]);
    const anchor = document.createElement("a");
    vi.spyOn(document, "createElement").mockReturnValue(
      Object.assign(anchor, {
        click: () => {
          saved.push({ name: anchor.download, body: "" });
        },
      }),
    );

    await userEvent.setup().click(screen.getByRole("button", { name: /export/i }));
    expect(saved[0]?.name).toMatch(/\.csv$/);
    vi.restoreAllMocks();
  });
});

describe("a row nobody could price", () => {
  it("does not show it as costing nothing", () => {
    // "$0.00" beside a model reads as "this one is free", which is the opposite
    // of what is known about it.
    open([spend("u1", iris.id, null)]);
    const panel = screen.getByRole("group", { name: /by model/i });

    expect(panel).not.toHaveTextContent("$0.00");
    expect(panel).toHaveTextContent(/not priced|unpriced|no price/i);
  });

  it("still shows what is known beside what is not", () => {
    open([spend("u1", iris.id, 2), spend("u2", iris.id, null)]);
    const panel = screen.getByRole("group", { name: /by person/i });

    expect(panel).toHaveTextContent("$2.00");
    expect(panel).toHaveTextContent(/not priced|unpriced|1 call/i);
  });
});

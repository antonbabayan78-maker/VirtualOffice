import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createEmployee,
  unwrap,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { EmployeeDrawer } from "./EmployeeDrawer.js";

const officeId = "office-acme" as OfficeId;
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

const person = (id: string, name: string): Employee =>
  unwrap(
    createEmployee(
      {
        name,
        role: "Engineer",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      { department: { id: eng.id, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

const ada = person("emp-ada", "Ada");
const grace = person("emp-grace", "Grace");

let store: OfficeStore;
let view: ReturnType<typeof render>;

function open(selected: EmployeeId | null = ada.id) {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([eng], [ada, grace]);
  if (selected !== null) store.getState().selectEmployee(selected);
  return render(<EmployeeDrawer store={store} />);
}

beforeEach(() => {
  view = open();
});

describe("the employee drawer", () => {
  it("stays out of the way until somebody is selected", () => {
    // Replace the drawer this test's setup opened, rather than adding a second.
    view.unmount();
    open(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the person who was selected", () => {
    expect(screen.getByRole("dialog", { name: /Ada/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Role")).toHaveValue("Engineer");
  });

  it("says which department they are in", () => {
    expect(screen.getByRole("dialog")).toHaveTextContent("Engineering");
  });

  it("saves a change to the office", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Role"));
    await user.type(screen.getByLabelText("Role"), "Staff engineer");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(store.getState().employees.find((e) => e.id === ada.id)?.role).toBe("Staff engineer");
  });

  it("keeps an unsaved change out of the office until it is saved", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Role"));
    await user.type(screen.getByLabelText("Role"), "Nothing yet");
    expect(store.getState().employees.find((e) => e.id === ada.id)?.role).toBe("Engineer");
  });

  it("shows what was wrong rather than saving nonsense", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/name/i);
    expect(store.getState().employees.find((e) => e.id === ada.id)?.name).toBe("Ada");
  });

  it("offers the models the registry knows, not a list of its own", () => {
    const models = screen.getByLabelText("Model");
    expect(models).toHaveValue("anthropic/claude-sonnet-5");
    expect(models.querySelectorAll("option").length).toBeGreaterThan(1);
  });

  it("offers the other people as supervisor, never the person themselves", () => {
    const supervisor = screen.getByLabelText("Reports to");
    const names = [...supervisor.querySelectorAll("option")].map((o) => o.textContent);
    expect(names).toContain("Grace");
    expect(names).not.toContain("Ada");
  });

  it("appoints a supervisor", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Reports to"), grace.id);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(store.getState().employees.find((e) => e.id === ada.id)?.supervisorId).toBe(grace.id);
  });

  it("takes skills as a list", async () => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Skills"), "sql, code-review");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(store.getState().employees.find((e) => e.id === ada.id)?.skillIds).toEqual([
      "sql",
      "code-review",
    ]);
  });

  it("builds a fallback chain in the order it was added", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Add a fallback"), "anthropic/claude-opus-5");
    await user.click(screen.getByRole("button", { name: /add fallback/i }));
    await user.selectOptions(screen.getByLabelText("Add a fallback"), "anthropic/claude-haiku-4-5");
    await user.click(screen.getByRole("button", { name: /add fallback/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(store.getState().employees.find((e) => e.id === ada.id)?.llm.fallbacks).toEqual([
      { provider: "anthropic", model: "claude-opus-5" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ]);
  });

  it("drops a fallback that is no longer wanted", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Add a fallback"), "anthropic/claude-opus-5");
    await user.click(screen.getByRole("button", { name: /add fallback/i }));
    await user.click(screen.getByRole("button", { name: /remove claude-opus-5/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(store.getState().employees.find((e) => e.id === ada.id)?.llm.fallbacks).toEqual([]);
  });

  it("has an employee follow their department's hours by default", () => {
    expect(screen.getByLabelText("Working hours")).toHaveValue("department");
    expect(screen.queryByLabelText("Timezone")).toBeNull();
  });

  it("gives an employee hours of their own", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Working hours"), "own");
    await user.clear(screen.getByLabelText("Timezone"));
    await user.type(screen.getByLabelText("Timezone"), "Asia/Nicosia");
    await user.click(screen.getByRole("checkbox", { name: "sat" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const saved = store.getState().employees.find((e) => e.id === ada.id)?.schedule;
    expect(saved).toMatchObject({ kind: "windows", timezone: "Asia/Nicosia" });
    if (saved?.kind === "windows") {
      expect(saved.windows[0]?.days).toContain("sat");
      expect(saved.windows[0]?.start).toBe("09:00");
    }
  });

  it("says what is wrong with a timezone rather than saving it", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Working hours"), "own");
    await user.clear(screen.getByLabelText("Timezone"));
    await user.type(screen.getByLabelText("Timezone"), "Mars/Olympus");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/timezone/i);
  });

  it("hands an employee back to their department's hours", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Working hours"), "own");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(store.getState().employees.find((e) => e.id === ada.id)?.schedule).not.toBeNull();

    // Re-opening is a store change from outside React, so it needs flushing.
    act(() => {
      store.getState().selectEmployee(ada.id);
    });
    await user.selectOptions(screen.getByLabelText("Working hours"), "department");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(store.getState().employees.find((e) => e.id === ada.id)?.schedule).toBeNull();
  });

  it("closes without keeping the changes", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Role"));
    await user.type(screen.getByLabelText("Role"), "Abandoned");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.getState().selectedEmployeeId).toBeNull();
    expect(store.getState().employees.find((e) => e.id === ada.id)?.role).toBe("Engineer");
  });

  it("closes on Escape, since a drawer that traps you is worse than none", async () => {
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    expect(store.getState().selectedEmployeeId).toBeNull();
  });
});

describe("an employee's standing priority", () => {
  it("shows what it is set to", () => {
    expect(screen.getByLabelText(/priority/i)).toHaveValue("normal");
  });

  it("tells somebody to yield to their colleagues", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/priority/i), "low");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(store.getState().employees.find((e) => e.id === ada.id)?.priority).toBe("low");
  });
});

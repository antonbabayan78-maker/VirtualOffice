import { beforeEach, describe, expect, it } from "vitest";
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
import { createOfficeStore, type OfficeStore } from "./office-store.js";
import { availableModels, supervisorChoices } from "./employee-edit.js";

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

const person = (id: string, name: string, status: "active" | "paused" = "active"): Employee => {
  const made = unwrap(
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
  return { ...made, status };
};

const ada = person("emp-ada", "Ada");
const grace = person("emp-grace", "Grace");
const gone = person("emp-gone", "Gone", "paused");

let store: OfficeStore;
beforeEach(() => {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([eng], [ada, grace, gone]);
});

describe("who can supervise whom", () => {
  it("offers the other people in the office", () => {
    expect(supervisorChoices(store.getState().employees, ada).map((e) => e.name)).toContain(
      "Grace",
    );
  });

  it("never offers you yourself", () => {
    expect(supervisorChoices(store.getState().employees, ada).map((e) => e.id)).not.toContain(
      ada.id,
    );
  });

  it("does not offer somebody who is not working", () => {
    expect(supervisorChoices(store.getState().employees, ada).map((e) => e.name)).not.toContain(
      "Gone",
    );
  });
});

describe("which models an office may use", () => {
  it("comes from the registry rather than a list typed out here", () => {
    const models = availableModels();
    expect(models.length).toBeGreaterThan(1);
    for (const model of models) {
      expect(model.provider.length).toBeGreaterThan(0);
      expect(model.model.length).toBeGreaterThan(0);
      expect(model.label.length).toBeGreaterThan(0);
    }
  });

  it("includes the model the sample office uses", () => {
    expect(availableModels().map((m) => m.model)).toContain("claude-sonnet-5");
  });
});

describe("editing an employee", () => {
  it("changes what was asked and nothing else", () => {
    const result = store.getState().updateEmployee(ada.id, { role: "Staff engineer" });
    expect(result.ok).toBe(true);
    const after = store.getState().employees.find((e) => e.id === ada.id);
    expect(after?.role).toBe("Staff engineer");
    expect(after?.name).toBe("Ada");
  });

  it("refuses a change the office would not accept, and leaves the employee alone", () => {
    const result = store.getState().updateEmployee(ada.id, { name: "  " });
    expect(result.ok).toBe(false);
    expect(store.getState().employees.find((e) => e.id === ada.id)?.name).toBe("Ada");
  });

  it("appoints a supervisor from the office", () => {
    const result = store.getState().updateEmployee(ada.id, { supervisorId: grace.id });
    expect(result.ok).toBe(true);
    expect(store.getState().employees.find((e) => e.id === ada.id)?.supervisorId).toBe(grace.id);
  });

  it("refuses to make somebody their own supervisor", () => {
    expect(store.getState().updateEmployee(ada.id, { supervisorId: ada.id }).ok).toBe(false);
  });

  it("ignores an employee who is not in this office", () => {
    expect(store.getState().updateEmployee("emp-nobody" as EmployeeId, { role: "x" }).ok).toBe(
      false,
    );
  });

  it("keeps the fallback chain in the order it was given", () => {
    const chain = [
      { provider: "anthropic", model: "claude-opus-5" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ];
    store.getState().updateEmployee(ada.id, {
      llm: { provider: "anthropic", model: "claude-sonnet-5", fallbacks: chain },
    });
    expect(store.getState().employees.find((e) => e.id === ada.id)?.llm.fallbacks).toEqual(chain);
  });
});

describe("selecting an employee", () => {
  it("remembers who is selected, and lets go", () => {
    store.getState().selectEmployee(ada.id);
    expect(store.getState().selectedEmployeeId).toBe(ada.id);
    store.getState().selectEmployee(null);
    expect(store.getState().selectedEmployeeId).toBeNull();
  });

  it("selecting an employee puts the department selection aside", () => {
    store.getState().select(eng.id);
    store.getState().selectEmployee(ada.id);
    expect(store.getState().selectedId).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { DepartmentId } from "../department/department.js";
import { createDepartment, type Department } from "../department/department.js";
import type { EmployeeId } from "../employee/employee.js";
import { createEmployee, type Employee } from "../employee/employee.js";
import { createOffice, type Office, type OfficeId } from "../office/office.js";
import { unwrap } from "../shared/result.js";
import {
  countChanges,
  diffOfficeConfig,
  diffValues,
  isEmptyDiff,
  type OfficeConfig,
} from "./snapshot.js";

const officeId = "o1" as OfficeId;
const t0 = new Date("2026-09-22T00:00:00Z");
const deps = <T extends string>(id: T) => ({ id: () => id, now: () => t0 });

const office: Office = unwrap(createOffice({ name: "Acme" }, deps(officeId)));
const eng: Department = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3b82f6", position: { x: 0, y: 0 } },
    [],
    deps("d1" as DepartmentId),
  ),
);
const sales: Department = unwrap(
  createDepartment(
    { officeId, name: "Sales", color: "#10b981", position: { x: 500, y: 0 } },
    [],
    deps("d2" as DepartmentId),
  ),
);
const ada: Employee = unwrap(
  createEmployee(
    {
      name: "Ada",
      role: "Engineer",
      color: "#000000",
      llm: { provider: "anthropic", model: "claude-sonnet-5" },
      skillIds: ["tdd"],
    },
    { department: { id: eng.id, officeId }, supervisor: null },
    deps("e1" as EmployeeId),
  ),
);

const base: OfficeConfig = {
  office,
  departments: [eng],
  employees: [ada],
  connections: [],
  connectors: [],
};

describe("diffValues", () => {
  it("returns no changes for deep-equal values including Dates", () => {
    expect(
      diffValues({ a: 1, b: { c: [1, 2], d: t0 } }, { a: 1, b: { c: [1, 2], d: new Date(t0) } }),
    ).toEqual([]);
  });

  it("reports nested paths, array indexes, additions and removals", () => {
    const changes = diffValues(
      { name: "A", llm: { model: "x", params: { temperature: 0.1 } }, skills: ["a", "b"], gone: 1 },
      { name: "B", llm: { model: "y", params: {} }, skills: ["a", "c", "d"], added: true },
    );
    expect(changes).toEqual([
      { path: "name", before: "A", after: "B" },
      { path: "llm.model", before: "x", after: "y" },
      { path: "llm.params.temperature", before: 0.1, after: undefined },
      { path: "skills[1]", before: "b", after: "c" },
      { path: "skills[2]", before: undefined, after: "d" },
      { path: "gone", before: 1, after: undefined },
      { path: "added", before: undefined, after: true },
    ]);
  });

  it("treats a Date change and a type change as single changes at that path", () => {
    expect(diffValues({ at: t0 }, { at: new Date("2027-01-01T00:00:00Z") })).toEqual([
      { path: "at", before: t0, after: new Date("2027-01-01T00:00:00Z") },
    ]);
    expect(diffValues({ v: { a: 1 } }, { v: "str" })).toEqual([
      { path: "v", before: { a: 1 }, after: "str" },
    ]);
    expect(diffValues({ v: null }, { v: 0 })).toEqual([{ path: "v", before: null, after: 0 }]);
  });
});

describe("diffOfficeConfig", () => {
  it("is empty for identical configs", () => {
    const diff = diffOfficeConfig(base, structuredClone(base));
    expect(isEmptyDiff(diff)).toBe(true);
    expect(countChanges(diff)).toBe(0);
  });

  it("detects office field changes and added, removed and changed entities per collection", () => {
    const renamedAda: Employee = {
      ...ada,
      name: "Ada L.",
      llm: { ...ada.llm, model: "claude-fable-5-1" },
    };
    const after: OfficeConfig = {
      office: { ...office, name: "Acme Studio", configVersion: 2 },
      departments: [sales],
      employees: [renamedAda],
      connections: [],
      connectors: [],
    };
    const diff = diffOfficeConfig(base, after);
    expect(diff.office).toEqual([
      { path: "name", before: "Acme", after: "Acme Studio" },
      { path: "configVersion", before: 1, after: 2 },
    ]);
    expect(diff.departments.added.map((d) => d.id)).toEqual(["d2"]);
    expect(diff.departments.removed.map((d) => d.id)).toEqual(["d1"]);
    expect(diff.departments.changed).toEqual([]);
    expect(diff.employees.changed).toHaveLength(1);
    expect(diff.employees.changed[0]).toMatchObject({ id: "e1" });
    expect(diff.employees.changed[0]?.fields).toEqual([
      { path: "name", before: "Ada", after: "Ada L." },
      { path: "llm.model", before: "claude-sonnet-5", after: "claude-fable-5-1" },
    ]);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(countChanges(diff)).toBe(2 + 1 + 1 + 1);
  });

  it("ignores entity order", () => {
    const shuffled: OfficeConfig = { ...base, departments: [sales, eng], employees: [ada] };
    const reordered: OfficeConfig = { ...base, departments: [eng, sales], employees: [ada] };
    expect(isEmptyDiff(diffOfficeConfig(shuffled, reordered))).toBe(true);
  });
});

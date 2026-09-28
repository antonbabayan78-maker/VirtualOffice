import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEPARTMENT_SIZE,
  MIN_DEPARTMENT_SIZE,
  createDepartment,
  unwrap,
  type Department,
  type DepartmentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "./office-store.js";
import type { StoredLayout } from "./layout-storage.js";

const officeId = "office-acme" as OfficeId;

function department(name: string, x: number, y: number): Department {
  return unwrap(
    createDepartment({ officeId, name, color: "#3366ff", position: { x, y } }, [], {
      id: () => `dept-${name.toLowerCase()}` as DepartmentId,
      now: () => new Date("2026-09-28T09:00:00Z"),
    }),
  );
}

const eng = department("Engineering", 0, 0);
const sales = department("Sales", 600, 0);

function memoryStorage(initial: StoredLayout | null = null) {
  let saved = initial;
  return {
    port: {
      readLayout: () => saved,
      writeLayout: (layout: StoredLayout) => {
        saved = layout;
      },
    },
    saved: () => saved,
  };
}

let store: OfficeStore;
let storage: ReturnType<typeof memoryStorage>;

function open(
  departments: readonly Department[] = [eng, sales],
  employees: readonly Employee[] = [],
  initial: StoredLayout | null = null,
) {
  storage = memoryStorage(initial);
  store = createOfficeStore({
    storage: storage.port,
    id: () => "dept-new" as DepartmentId,
    now: () => new Date("2026-09-28T10:00:00Z"),
  });
  store.getState().load(departments, employees);
  return store;
}

beforeEach(() => {
  open();
});

describe("loading an office", () => {
  it("shows the departments the office has", () => {
    expect(store.getState().departments.map((d) => d.name)).toEqual(["Engineering", "Sales"]);
  });

  it("puts each one where the office file says", () => {
    expect(store.getState().departments[0]?.position).toEqual({ x: 0, y: 0 });
    expect(store.getState().departments[1]?.position).toEqual({ x: 600, y: 0 });
  });

  it("gives a department the default size when the file gave none", () => {
    expect(store.getState().departments[0]?.size).toEqual(DEFAULT_DEPARTMENT_SIZE);
  });
});

describe("moving a department", () => {
  it("moves it", () => {
    store.getState().moveDepartment(eng.id, { x: 120, y: 80 });
    expect(store.getState().departments[0]?.position).toEqual({ x: 120, y: 80 });
  });

  it("leaves the others alone", () => {
    store.getState().moveDepartment(eng.id, { x: 120, y: 80 });
    expect(store.getState().departments[1]?.position).toEqual({ x: 600, y: 0 });
  });

  it("ignores a department that is not there", () => {
    const before = store.getState().departments;
    store.getState().moveDepartment("dept-nowhere" as DepartmentId, { x: 1, y: 1 });
    expect(store.getState().departments).toEqual(before);
  });

  it("snaps to the grid when snapping is on", () => {
    store.getState().setSnapToGrid(true);
    store.getState().moveDepartment(eng.id, { x: 97, y: 33 });
    // A 20px grid: 97 -> 100, 33 -> 40.
    expect(store.getState().departments[0]?.position).toEqual({ x: 100, y: 40 });
  });

  it("leaves the position exactly where it was put when snapping is off", () => {
    store.getState().moveDepartment(eng.id, { x: 97, y: 33 });
    expect(store.getState().departments[0]?.position).toEqual({ x: 97, y: 33 });
  });
});

describe("resizing a department", () => {
  it("resizes it", () => {
    store.getState().resizeDepartment(eng.id, { width: 640, height: 400 });
    expect(store.getState().departments[0]?.size).toEqual({ width: 640, height: 400 });
  });

  it("will not go below the size core allows", () => {
    store.getState().resizeDepartment(eng.id, { width: 10, height: 10 });
    expect(store.getState().departments[0]?.size).toEqual(MIN_DEPARTMENT_SIZE);
  });

  it("snaps the size to the grid too", () => {
    store.getState().setSnapToGrid(true);
    store.getState().resizeDepartment(eng.id, { width: 453, height: 328 });
    expect(store.getState().departments[0]?.size).toEqual({ width: 460, height: 320 });
  });
});

describe("adding a department", () => {
  it("adds one where it was dropped", () => {
    const added = store
      .getState()
      .addDepartment({ name: "Legal", color: "#884400", position: { x: 40, y: 500 } });
    expect(added.ok).toBe(true);
    expect(store.getState().departments.map((d) => d.name)).toContain("Legal");
    expect(store.getState().departments.at(-1)?.position).toEqual({ x: 40, y: 500 });
  });

  it("refuses a name the office already uses, and says why", () => {
    const added = store
      .getState()
      .addDepartment({ name: "Engineering", color: "#884400", position: { x: 0, y: 0 } });
    expect(added.ok).toBe(false);
    if (!added.ok) expect(added.error[0]?.message).toMatch(/name/i);
    expect(store.getState().departments).toHaveLength(2);
  });

  it("refuses a colour that is not a colour", () => {
    const added = store
      .getState()
      .addDepartment({ name: "Legal", color: "nope", position: { x: 0, y: 0 } });
    expect(added.ok).toBe(false);
    expect(store.getState().departments).toHaveLength(2);
  });
});

describe("the people in the office", () => {
  it("has nobody until an office is loaded with employees", () => {
    expect(store.getState().employees).toEqual([]);
  });

  it("keeps everyone idle until something says otherwise", () => {
    open([eng], [], undefined);
    expect(store.getState().activityOf("emp-ada" as EmployeeId)).toBe("idle");
  });

  it("records what an employee is doing", () => {
    store.getState().setActivity("emp-ada" as EmployeeId, "working");
    expect(store.getState().activityOf("emp-ada" as EmployeeId)).toBe("working");
  });

  it("leaves everyone else alone", () => {
    store.getState().setActivity("emp-ada" as EmployeeId, "error");
    expect(store.getState().activityOf("emp-bob" as EmployeeId)).toBe("idle");
  });
});

describe("selection", () => {
  it("selects and deselects", () => {
    store.getState().select(eng.id);
    expect(store.getState().selectedId).toBe(eng.id);
    store.getState().select(null);
    expect(store.getState().selectedId).toBeNull();
  });
});

describe("remembering the layout", () => {
  it("writes a move to storage", () => {
    store.getState().moveDepartment(eng.id, { x: 120, y: 80 });
    expect(storage.saved()?.departments[eng.id]).toMatchObject({ position: { x: 120, y: 80 } });
  });

  it("writes a resize to storage", () => {
    store.getState().resizeDepartment(eng.id, { width: 640, height: 400 });
    expect(storage.saved()?.departments[eng.id]).toMatchObject({
      size: { width: 640, height: 400 },
    });
  });

  it("remembers whether snapping was on", () => {
    store.getState().setSnapToGrid(true);
    expect(storage.saved()?.snapToGrid).toBe(true);
  });

  it("puts departments back where they were left", () => {
    open([eng, sales], [], {
      departments: {
        [eng.id]: { position: { x: 300, y: 200 }, size: { width: 500, height: 340 } },
      },
      snapToGrid: true,
    });
    expect(store.getState().departments[0]?.position).toEqual({ x: 300, y: 200 });
    expect(store.getState().departments[0]?.size).toEqual({ width: 500, height: 340 });
    expect(store.getState().settings.snapToGrid).toBe(true);
  });

  it("ignores a remembered layout for a department the office no longer has", () => {
    open([eng], [], {
      departments: { "dept-gone": { position: { x: 1, y: 1 }, size: { width: 300, height: 300 } } },
      snapToGrid: false,
    });
    expect(store.getState().departments).toHaveLength(1);
    expect(store.getState().departments[0]?.name).toBe("Engineering");
  });
});

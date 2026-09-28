import { beforeEach, describe, expect, it } from "vitest";
import {
  createDepartment,
  unwrap,
  type Department,
  type DepartmentId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { PALETTE_ITEMS, departmentAt, dropItem } from "./drop.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");
let nextId = 0;

function department(id: string, name: string, x: number, y: number): Department {
  return unwrap(
    createDepartment(
      { officeId, name, color: "#3366ff", position: { x, y }, size: { width: 400, height: 300 } },
      [],
      { id: () => id as DepartmentId, now: () => at },
    ),
  );
}

const eng = department("dept-eng", "Engineering", 0, 0); // 0,0 .. 400,300
const sales = department("dept-sales", "Sales", 500, 0); // 500,0 .. 900,300

let store: OfficeStore;

beforeEach(() => {
  nextId = 0;
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => `new-${String(++nextId)}` as DepartmentId,
    now: () => at,
  });
  store.getState().load([eng, sales], []);
});

describe("what is under the pointer", () => {
  it("finds the department a point is inside", () => {
    expect(departmentAt(store.getState().departments, { x: 100, y: 100 })?.name).toBe(
      "Engineering",
    );
    expect(departmentAt(store.getState().departments, { x: 600, y: 50 })?.name).toBe("Sales");
  });

  it("finds nothing in the gap between them", () => {
    expect(departmentAt(store.getState().departments, { x: 450, y: 100 })).toBeNull();
  });

  it("counts the edges as inside, so a drop on the border lands somewhere", () => {
    expect(departmentAt(store.getState().departments, { x: 0, y: 0 })?.name).toBe("Engineering");
    expect(departmentAt(store.getState().departments, { x: 400, y: 300 })?.name).toBe(
      "Engineering",
    );
  });

  it("picks the one on top when two overlap", () => {
    const over = department("dept-over", "Overlap", 100, 100);
    store.getState().load([eng, over], []);
    // The later department is drawn on top, so it is what you dropped onto.
    expect(departmentAt(store.getState().departments, { x: 200, y: 200 })?.name).toBe("Overlap");
  });
});

describe("dropping a person", () => {
  it("hires them into the department they were dropped on", () => {
    const result = dropItem(store, "person", { x: 100, y: 100 });
    expect(result.ok).toBe(true);
    const hired = store.getState().employees;
    expect(hired).toHaveLength(1);
    expect(hired[0]?.departmentId).toBe("dept-eng");
  });

  it("says a person needs a department when dropped on bare canvas", () => {
    const result = dropItem(store, "person", { x: 450, y: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/department/i);
    expect(store.getState().employees).toHaveLength(0);
  });

  it("leaves the notice where the canvas can show it", () => {
    dropItem(store, "person", { x: 450, y: 100 });
    expect(store.getState().notice).toMatch(/department/i);
  });

  it("gives them the colour of the department they joined", () => {
    dropItem(store, "person", { x: 100, y: 100 });
    expect(store.getState().employees[0]?.color).toBe(eng.color);
  });

  it("starts them active and idle, with nobody above them yet", () => {
    dropItem(store, "person", { x: 100, y: 100 });
    const hired = store.getState().employees[0];
    expect(hired?.status).toBe("active");
    expect(hired?.supervisorId).toBeNull();
    expect(store.getState().activityOf(hired?.id ?? ("x" as never))).toBe("idle");
  });

  it("numbers each new hire so two drops are two people", () => {
    dropItem(store, "person", { x: 100, y: 100 });
    dropItem(store, "person", { x: 150, y: 150 });
    const names = store.getState().employees.map((e) => e.name);
    expect(new Set(names).size).toBe(2);
  });
});

describe("dropping a department", () => {
  it("puts a new one where it was dropped", () => {
    const result = dropItem(store, "department", { x: 200, y: 600 });
    expect(result.ok).toBe(true);
    const added = store.getState().departments.at(-1);
    expect(added?.position).toEqual({ x: 200, y: 600 });
  });

  it("is happy on bare canvas, which is where a department belongs", () => {
    expect(dropItem(store, "department", { x: 450, y: 800 }).ok).toBe(true);
  });

  it("refuses to drop one inside another, and says why", () => {
    const result = dropItem(store, "department", { x: 100, y: 100 });
    expect(result.ok).toBe(false);
    // The hint names what it clashed with, which is more use than "invalid".
    if (!result.ok) expect(result.notice).toMatch(/Engineering/);
    expect(store.getState().departments).toHaveLength(2);
  });

  it("names each one differently, since the office will not take a repeat", () => {
    dropItem(store, "department", { x: 0, y: 600 });
    dropItem(store, "department", { x: 0, y: 1000 });
    const names = store.getState().departments.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the palette", () => {
  it("offers a person and a department", () => {
    expect(PALETTE_ITEMS.map((item) => item.kind)).toEqual(["department", "person"]);
  });

  it("says what each one needs, so the hint is not a surprise", () => {
    for (const item of PALETTE_ITEMS) {
      expect(item.hint.length, item.kind).toBeGreaterThan(0);
    }
  });
});

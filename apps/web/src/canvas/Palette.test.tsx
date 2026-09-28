import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  unwrap,
  type Department,
  type DepartmentId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { Palette } from "./Palette.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");
let ids = 0;

const eng: Department = unwrap(
  createDepartment(
    { officeId, name: "Engineering", color: "#3366ff", position: { x: 0, y: 0 } },
    [],
    { id: () => "dept-eng" as DepartmentId, now: () => at },
  ),
);

let store: OfficeStore;

beforeEach(() => {
  ids = 0;
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => `new-${String(++ids)}`,
    now: () => at,
  });
  store.getState().load([eng], []);
  render(<Palette store={store} />);
});

describe("the palette", () => {
  it("offers a department and a person", () => {
    expect(screen.getByRole("button", { name: /department/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /person/i })).toBeInTheDocument();
  });

  it("says what each one needs before you try it", () => {
    expect(screen.getByRole("button", { name: /person/i })).toHaveAccessibleDescription(
      /inside a department/i,
    );
  });

  it("carries what is being dragged, so the canvas knows what landed", () => {
    const person = screen.getByRole("button", { name: /person/i });
    const data = new Map<string, string>();
    fireEvent.dragStart(person, {
      dataTransfer: {
        setData: (type: string, value: string) => data.set(type, value),
        effectAllowed: "",
      },
    });
    expect(data.get("application/vo-palette-item")).toBe("person");
  });
});

describe("adding without a mouse", () => {
  it("hires into the selected department when a person is chosen", async () => {
    const user = userEvent.setup();
    store.getState().select("dept-eng" as DepartmentId);
    await user.click(screen.getByRole("button", { name: /person/i }));
    expect(store.getState().employees).toHaveLength(1);
    expect(store.getState().employees[0]?.departmentId).toBe("dept-eng");
  });

  it("says which department to pick first when none is selected", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /person/i }));
    expect(store.getState().employees).toHaveLength(0);
    expect(store.getState().notice).toMatch(/select a department/i);
  });

  it("opens a new department clear of the others", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /department/i }));
    expect(store.getState().departments).toHaveLength(2);
    const added = store.getState().departments.at(-1);
    // Not on top of the one that was already there.
    expect(added?.position).not.toEqual(eng.position);
  });

  it("is reachable by keyboard, not only by pointer", async () => {
    const user = userEvent.setup();
    store.getState().select("dept-eng" as DepartmentId);
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(store.getState().employees.length + store.getState().departments.length).toBeGreaterThan(
      1,
    );
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
import { Canvas } from "./Canvas.js";
import { installCanvasTestEnv } from "./canvas-test-env.js";

beforeAll(installCanvasTestEnv);

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");

const department = (id: string, name: string, color: string): Department =>
  unwrap(
    createDepartment({ officeId, name, color, position: { x: 0, y: 0 } }, [], {
      id: () => id as DepartmentId,
      now: () => at,
    }),
  );

const eng = department("dept-eng", "Engineering", "#3366ff");
const sales = department("dept-sales", "Sales", "#cc3366");

const employee = (id: string, name: string, departmentId: string): Employee =>
  unwrap(
    createEmployee(
      {
        name,
        role: "Engineer",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      { department: { id: departmentId as DepartmentId, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );

function openCanvas(): OfficeStore {
  const store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "dept-new",
    now: () => at,
  });
  store
    .getState()
    .load(
      [eng, sales],
      [employee("emp-ada", "Ada", "dept-eng"), employee("emp-bob", "Bob", "dept-sales")],
    );
  render(<Canvas store={store} />);
  return store;
}

describe("the canvas", () => {
  it("shows a room for every department", () => {
    openCanvas();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Sales")).toBeInTheDocument();
  });

  it("puts each employee in their own department", () => {
    openCanvas();
    const rooms = screen.getAllByTestId("department");
    const engineering = rooms.find((room) => within(room).queryByText("Engineering") !== null);
    expect(engineering).toBeDefined();
    if (engineering) {
      expect(within(engineering).getByRole("img", { name: /Ada/ })).toBeInTheDocument();
      expect(within(engineering).queryByRole("img", { name: /Bob/ })).toBeNull();
    }
  });

  it("counts the people in each room", () => {
    openCanvas();
    expect(screen.getAllByText("1 person")).toHaveLength(2);
  });

  it("shows what everyone is doing, and keeps up when a task moves", async () => {
    const store = openCanvas();
    expect(screen.getByRole("img", { name: "Ada: idle" })).toBeInTheDocument();

    // A task of Ada's starts moving: the canvas should show it without asking.
    store.getState().putTask({
      id: "task-1",
      status: "in_progress",
      assigneeId: "emp-ada",
      reviewerIds: [],
    } as never);
    expect(await screen.findByRole("img", { name: "Ada: working" })).toBeInTheDocument();
  });

  it("puts a chip on somebody who is busy, and none on somebody who is not", async () => {
    const store = openCanvas();
    expect(screen.queryByText(/working/)).toBeNull();

    store.getState().putTask({
      id: "task-1",
      status: "in_progress",
      assigneeId: "emp-ada",
      reviewerIds: [],
    } as never);
    expect(await screen.findByText("working")).toBeInTheDocument();
  });

  it("says what a waiting employee is waiting for", async () => {
    const store = openCanvas();
    store.getState().putTask({
      id: "task-1",
      status: "in_review",
      assigneeId: "emp-ada",
      reviewerIds: [],
    } as never);
    expect(await screen.findByText(/waiting/)).toBeInTheDocument();
  });

  it("offers the grid, and remembers that it was asked for", async () => {
    const user = userEvent.setup();
    const store = openCanvas();
    const snap = screen.getByRole("checkbox", { name: /snap to grid/i });
    expect(snap).not.toBeChecked();
    await user.click(snap);
    expect(store.getState().settings.snapToGrid).toBe(true);
    expect(snap).toBeChecked();
  });

  it("has a minimap to find your way around a big office", () => {
    openCanvas();
    expect(document.querySelector(".react-flow__minimap")).not.toBeNull();
  });

  it("has zoom controls", () => {
    openCanvas();
    expect(screen.getByRole("button", { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /zoom out/i })).toBeInTheDocument();
  });

  it("says so when the office is empty rather than showing a blank page", () => {
    const store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "dept-new",
      now: () => at,
    });
    render(<Canvas store={store} />);
    expect(screen.getByText(/no departments yet/i)).toBeInTheDocument();
  });
});

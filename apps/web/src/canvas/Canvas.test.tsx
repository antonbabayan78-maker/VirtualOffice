import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createEmployee,
  unwrap,
  type Department,
  type DepartmentId,
  type Connection,
  type ConnectionId,
  type Employee,
  type EmployeeId,
  type Office,
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
// Nobody works here, which is what makes it deletable.
const ops = department("dept-ops", "Operations", "#f59e0b");

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

const link = (from: Department, to: Department, kind = "handoff"): Connection => ({
  id: `conn-${from.id}-${to.id}-${kind}` as ConnectionId,
  officeId,
  fromId: from.id,
  toId: to.id,
  kind: kind as Connection["kind"],
  enabled: true,
  rules: {},
  createdAt: at,
});

function openCanvas(connections: readonly Connection[] = []): OfficeStore {
  const store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "dept-new",
    now: () => at,
  });
  store
    .getState()
    .load(
      [eng, sales, ops],
      [employee("emp-ada", "Ada", "dept-eng"), employee("emp-bob", "Bob", "dept-sales")],
      [],
      connections,
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

describe("the arrows between departments", () => {
  it("hands the canvas one arrow per relationship", () => {
    const store = openCanvas([link(eng, sales)]);
    expect(store.getState().links).toHaveLength(1);
  });

  it("hands it one arrow, not two, when the work goes both ways", () => {
    const store = openCanvas([link(eng, sales), link(sales, eng)]);
    expect(store.getState().links).toHaveLength(1);
    expect(store.getState().links[0]?.twoWay).toBe(true);
  });
});

describe("closing a department down", () => {
  it("offers to remove an empty department when it is right-clicked", async () => {
    const user = userEvent.setup();
    openCanvas();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Operations") });

    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeTruthy();
  });

  it("removes it when that is chosen", async () => {
    const user = userEvent.setup();
    const store = openCanvas();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Operations") });
    await user.click(screen.getByRole("menuitem", { name: /delete/i }));

    expect(store.getState().departments.map((d) => d.name)).toEqual(["Engineering", "Sales"]);
  });

  it("will not offer to delete a department with people in it", async () => {
    const user = userEvent.setup();
    openCanvas();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Engineering") });

    const item = screen.getByRole("menuitem", { name: /delete/i });
    expect(item.getAttribute("aria-disabled")).toBe("true");
  });

  it("says why it cannot, rather than a button that does nothing", async () => {
    const user = userEvent.setup();
    openCanvas();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Engineering") });

    expect(screen.getByText(/still has 1 person/i)).toBeTruthy();
  });

  it("closes the menu without deleting anything when the canvas is clicked", async () => {
    const user = userEvent.setup();
    const store = openCanvas();
    await user.pointer({ keys: "[MouseRight]", target: screen.getByText("Operations") });
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menuitem", { name: /delete/i })).toBeNull();
    expect(store.getState().departments).toHaveLength(3);
  });
});

describe("pointing at somebody", () => {
  it("says nothing until they are pointed at", () => {
    openCanvas();
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says what they are for, what they are on, and what it costs", async () => {
    const user = userEvent.setup();
    openCanvas();
    await user.hover(screen.getByRole("button", { name: /Configure Ada/ }));

    const tip = screen.getByRole("tooltip");
    expect(within(tip).getByText("Engineer")).toBeTruthy();
    expect(within(tip).getByText("Engineering")).toBeTruthy();
    expect(within(tip).getByText("claude-sonnet-5")).toBeTruthy();
  });

  it("names the task they are on rather than merely saying they are busy", async () => {
    const user = userEvent.setup();
    const store = openCanvas();
    store.getState().putTask({
      id: "task-1",
      officeId,
      departmentId: eng.id,
      title: "Rewrite the query planner",
      status: "in_progress",
      assigneeId: "emp-ada",
      reviewerIds: [],
      history: [],
    } as never);
    await user.hover(screen.getByRole("button", { name: /Configure Ada/ }));

    expect(within(screen.getByRole("tooltip")).getByText(/Rewrite the query planner/)).toBeTruthy();
  });

  it("stops saying it when the pointer moves away", async () => {
    const user = userEvent.setup();
    openCanvas();
    const figure = screen.getByRole("button", { name: /Configure Ada/ });
    await user.hover(figure);
    await user.unhover(figure);

    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says the same thing to somebody using a keyboard", () => {
    openCanvas();
    // Focused rather than tabbed to: what matters is that focus alone shows it,
    // not where the figure happens to sit in the canvas's tab order.
    fireEvent.focus(screen.getByRole("button", { name: /Configure Ada/ }));

    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });
});

describe("choosing an arrow", () => {
  // React Flow draws its arrows as SVG paths measured from the DOM, which jsdom
  // has none of; which connection a click opens is tested in edges.test.ts,
  // where it is a function rather than a rendered line.
  it("opens nothing until one is chosen", () => {
    const store = openCanvas([link(eng, sales)]);
    expect(store.getState().selectedConnectionId).toBeNull();
  });
});

describe("work that is not happening, seen without opening anything", () => {
  const acme: Office = {
    id: officeId,
    name: "Acme Robotics",
    schedule: { kind: "always" },
    priority: "normal",
    runState: "running",
    budget: null,
    configVersion: 1,
    createdAt: at,
  };

  const openWith = (office: Office, departments = [eng, sales, ops]) => {
    const store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "dept-new",
      now: () => at,
    });
    store.getState().loadOffice(office);
    store.getState().load(departments, [employee("emp-ada", "Ada", "dept-eng")], [], []);
    render(<Canvas store={store} />);
    return store;
  };

  it("says nothing when the office is working", () => {
    // A banner that is always there is a banner nobody reads.
    openWith(acme);
    expect(screen.queryByRole("status", { name: /stopped/i })).toBeNull();
  });

  it("says the office is stopped, without a drawer being opened", () => {
    // The failure worth designing against: a stopped office looks exactly like
    // a quiet one, and nothing on the canvas would tell you which you had.
    openWith({ ...acme, runState: "paused" });
    expect(screen.getByRole("status", { name: /stopped/i })).toHaveTextContent(/stopped/i);
  });

  it("says why nothing is moving, not only that something is off", () => {
    openWith({ ...acme, runState: "paused" });
    expect(screen.getByRole("status", { name: /stopped/i })).toHaveTextContent(
      /nothing|picked up|not being/i,
    );
  });

  it("marks a stopped department on the room itself", () => {
    openWith(acme, [{ ...eng, runState: "paused" }, sales, ops]);
    const rooms = screen.getAllByTestId("department");
    const engineering = rooms.find((room) => room.textContent.includes("Engineering"));

    expect(engineering).toBeDefined();
    expect(engineering).toHaveTextContent(/stopped/i);
  });

  it("leaves the working rooms unmarked", () => {
    openWith(acme, [{ ...eng, runState: "paused" }, sales, ops]);
    const rooms = screen.getAllByTestId("department");
    const salesRoom = rooms.find((room) => room.textContent.includes("Sales"));

    expect(salesRoom).not.toHaveTextContent(/stopped/i);
  });

  it("marks every room when the whole office is stopped", () => {
    // A room that looks live inside a stopped office is a worse lie than no
    // mark at all: its own switch is on, and it still picks up nothing.
    openWith({ ...acme, runState: "paused" });
    for (const room of screen.getAllByTestId("department")) {
      expect(room).toHaveTextContent(/stopped/i);
    }
  });
});

describe("a bench drawn inside its department", () => {
  const drafting = {
    id: "bench-draft" as never,
    name: "Drafting",
    memberIds: ["emp-ada" as EmployeeId],
    strategy: "round_robin" as const,
  };

  const openWith = (benches: readonly (typeof drafting)[]) => {
    const store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "dept-new",
      now: () => at,
    });
    store
      .getState()
      .load(
        [{ ...eng, benches }, sales],
        [employee("emp-ada", "Ada", "dept-eng"), employee("emp-bob", "Bob", "dept-eng")],
        [],
        [],
      );
    render(<Canvas store={store} />);
    return store;
  };

  const room = () => {
    const found = screen
      .getAllByTestId("department")
      .find((one) => one.textContent.includes("Engineering"));
    if (found === undefined) throw new Error("no Engineering room on the canvas");
    return found;
  };

  it("shows the bench by name inside the room", () => {
    openWith([drafting]);
    expect(within(room()).getByRole("group", { name: /Drafting/ })).toBeTruthy();
  });

  it("puts the people on it inside the box", () => {
    openWith([drafting]);
    const box = within(room()).getByRole("group", { name: /Drafting/ });
    expect(within(box).getByRole("button", { name: /Configure Ada/ })).toBeTruthy();
  });

  it("leaves everybody else in the room outside it", () => {
    openWith([drafting]);
    const box = within(room()).getByRole("group", { name: /Drafting/ });
    expect(within(box).queryByRole("button", { name: /Configure Bob/ })).toBeNull();
    expect(within(room()).getByRole("button", { name: /Configure Bob/ })).toBeTruthy();
  });

  it("draws no box at all in a room that has no bench", () => {
    openWith([]);
    expect(within(room()).queryByRole("group")).toBeNull();
  });

  it("still shows an empty bench, so it can be seen to exist", () => {
    // Otherwise a bench you made and have not filled looks like a failed save.
    openWith([{ ...drafting, memberIds: [] }]);
    expect(within(room()).getByRole("group", { name: /Drafting/ })).toBeTruthy();
  });
});

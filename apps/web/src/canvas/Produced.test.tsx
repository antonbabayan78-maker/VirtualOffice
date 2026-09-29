import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createDocument,
  createEmployee,
  createTask,
  unwrap,
  type Department,
  type DepartmentId,
  type Document,
  type DocumentId,
  type Employee,
  type EmployeeId,
  type OfficeId,
  type Task,
  type TaskId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { Produced } from "./Produced.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-30T09:00:00Z");

const design: Department = unwrap(
  createDepartment({ officeId, name: "Design", color: "#7c5cff", position: { x: 0, y: 0 } }, [], {
    id: () => "dept-design" as DepartmentId,
    now: () => at,
  }),
);

const person = (name: string, id: string): Employee =>
  unwrap(
    createEmployee(
      {
        name,
        role: "Designer",
        color: "#00aa66",
        llm: { provider: "anthropic", model: "claude-sonnet-5" },
      },
      { department: { id: design.id, officeId }, supervisor: null },
      { id: () => id as EmployeeId, now: () => at },
    ),
  );
const iris = person("Iris", "emp-iris");
const theo = person("Theo", "emp-theo");

const work = (id: string, title: string, assigneeId: EmployeeId | null): Task =>
  unwrap(
    createTask(
      {
        officeId,
        departmentId: design.id,
        title,
        ...(assigneeId === null ? {} : { assigneeId }),
      },
      { id: () => id as TaskId, now: () => at },
    ),
  );

const document = (id: string, taskId: string, overrides: Partial<Document> = {}): Document => ({
  ...unwrap(
    createDocument(
      {
        officeId,
        owner: { kind: "task", id: taskId },
        tray: "out",
        name: `${id}.md`,
        mediaType: "text/markdown",
        size: 4096,
      },
      { id: () => id as DocumentId, now: () => at },
    ),
  ),
  ...overrides,
});

let store: OfficeStore;

const mount = (owner: { kind: "employee" | "department"; id: string }) =>
  render(<Produced store={store} owner={owner} tray="out" />);

const section = () => screen.getByRole("group", { name: /produced by their work|produced here/i });

beforeEach(() => {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
    officeId,
  });
  store
    .getState()
    .load([design], [iris, theo], [work("task-screen", "Draw the export screen", iris.id)], []);
});

describe("what an employee's work produced", () => {
  it("shows nothing at all when their work has produced nothing", () => {
    // Not an empty box: there is no tray here, only a view of what exists.
    mount({ kind: "employee", id: iris.id });
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("lists what the tasks assigned to them have produced", () => {
    store.getState().loadDocuments([document("brief", "task-screen")]);
    mount({ kind: "employee", id: iris.id });

    expect(section()).toHaveTextContent("brief.md");
  });

  it("says which piece of work each one came out of", () => {
    // A document with no work attached to it is an orphan on a settings panel.
    store.getState().loadDocuments([document("brief", "task-screen")]);
    mount({ kind: "employee", id: iris.id });

    expect(section()).toHaveTextContent("Draw the export screen");
  });

  it("does not show what somebody else's work produced", () => {
    store.getState().loadDocuments([document("brief", "task-screen")]);
    mount({ kind: "employee", id: theo.id });

    expect(screen.queryByRole("group")).toBeNull();
  });

  it("does not show what was handed to the work, only what came out of it", () => {
    store
      .getState()
      .loadDocuments([
        document("given", "task-screen", { tray: "in" }),
        document("made", "task-screen"),
      ]);
    mount({ kind: "employee", id: iris.id });

    expect(section()).toHaveTextContent("made.md");
    expect(section()).not.toHaveTextContent("given.md");
  });

  it("does not show a document that belongs to the desk rather than the work", () => {
    // Those are the trays' business, and showing them twice would suggest two.
    store
      .getState()
      .loadDocuments([document("theirs", iris.id, { ownerKind: "employee", ownerId: iris.id })]);
    mount({ kind: "employee", id: iris.id });

    expect(screen.queryByRole("group")).toBeNull();
  });

  it("says how big each one is", () => {
    store.getState().loadDocuments([document("brief", "task-screen")]);
    mount({ kind: "employee", id: iris.id });

    expect(section()).toHaveTextContent("4 KB");
  });
});

describe("what a department's work produced", () => {
  it("gathers what every piece of work in the room produced", () => {
    store
      .getState()
      .load(
        [design],
        [iris, theo],
        [
          work("task-screen", "Draw the export screen", iris.id),
          work("task-icons", "Draw the icons", theo.id),
        ],
        [],
      );
    store
      .getState()
      .loadDocuments([document("screen", "task-screen"), document("icons", "task-icons")]);
    mount({ kind: "department", id: design.id });

    const items = within(section()).getAllByRole("listitem");
    expect(items).toHaveLength(2);
  });

  it("includes work nobody has picked up yet", () => {
    // A task in the backlog is still this department's work.
    store.getState().load([design], [iris], [work("task-loose", "Draw the empty state", null)], []);
    store.getState().loadDocuments([document("loose", "task-loose")]);
    mount({ kind: "department", id: design.id });

    expect(section()).toHaveTextContent("loose.md");
  });
});

describe("what this is not", () => {
  beforeEach(() => {
    store.getState().loadDocuments([document("brief", "task-screen")]);
    mount({ kind: "employee", id: iris.id });
  });

  it("cannot be dropped into, because work is not filed here by hand", () => {
    expect(within(section()).queryByLabelText(/add a document/i)).toBeNull();
  });

  it("offers no way to remove one", () => {
    // Deleting somebody's work product should not be a stray click on a panel
    // that is otherwise about their model settings.
    expect(within(section()).queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("does let you read it", async () => {
    const fetched = vi.fn().mockResolvedValue(new TextEncoder().encode("# Brief\n"));
    store.setState({ fetchBody: fetched } as never);

    await userEvent.setup().click(screen.getByRole("button", { name: "Download brief.md" }));
    expect(fetched).toHaveBeenCalledWith("brief");
  });
});

describe("what was handed to somebody's work", () => {
  beforeEach(() => {
    store
      .getState()
      .loadDocuments([
        document("carried", "task-screen", { tray: "in" }),
        document("made", "task-screen"),
      ]);
  });

  const handed = () => screen.getByRole("group", { name: /handed to their work/i });

  it("shows what another department handed across", () => {
    // Everything a handoff carries lands in the work's in-tray. Without this it
    // arrives, is read into the prompt, and is invisible to the person.
    render(<Produced store={store} owner={{ kind: "employee", id: iris.id }} tray="in" />);
    expect(handed()).toHaveTextContent("carried.md");
  });

  it("keeps it apart from what the work produced", () => {
    render(<Produced store={store} owner={{ kind: "employee", id: iris.id }} tray="in" />);
    expect(handed()).not.toHaveTextContent("made.md");
  });

  it("says which piece of work it was handed to", () => {
    render(<Produced store={store} owner={{ kind: "employee", id: iris.id }} tray="in" />);
    expect(handed()).toHaveTextContent("Draw the export screen");
  });

  it("is read-only too: you cannot take back what you were handed", () => {
    render(<Produced store={store} owner={{ kind: "employee", id: iris.id }} tray="in" />);
    expect(within(handed()).queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("gathers what a whole department was handed", () => {
    render(<Produced store={store} owner={{ kind: "department", id: design.id }} tray="in" />);
    expect(screen.getByRole("group", { name: /handed to this department/i })).toHaveTextContent(
      "carried.md",
    );
  });
});

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  createEmployee,
  unwrap,
  updateEmployee,
  type Connector,
  type ConnectorId,
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

describe("what is on their desk", () => {
  it("shows both trays, so work can be handed over and taken back", () => {
    // Wired here rather than only unit-tested on its own: a tray nobody mounted
    // is a tray nobody can use.
    expect(screen.getByRole("group", { name: /in-tray for employee/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /out-tray for employee/i })).toBeInTheDocument();
  });

  it("shows this employee's documents and not the department's", () => {
    act(() => {
      store.getState().loadDocuments([
        {
          id: "doc-1" as never,
          officeId: "office-acme" as never,
          ownerKind: "employee",
          ownerId: ada.id,
          tray: "in",
          name: "theirs.md",
          mediaType: "text/markdown",
          size: 4,
          blobRef: "office-acme/documents/doc-1",
          addedBy: null,
          addedAt: new Date("2026-09-29T09:00:00Z"),
        },
        {
          id: "doc-2" as never,
          officeId: "office-acme" as never,
          ownerKind: "department",
          ownerId: eng.id,
          tray: "in",
          name: "the-rooms.md",
          mediaType: "text/markdown",
          size: 4,
          blobRef: "office-acme/documents/doc-2",
          addedBy: null,
          addedAt: new Date("2026-09-29T09:00:00Z"),
        },
      ]);
    });

    const tray = screen.getByRole("group", { name: /in-tray for employee/i });
    expect(tray).toHaveTextContent("theirs.md");
    expect(tray).not.toHaveTextContent("the-rooms.md");
  });
});

describe("what their work has produced", () => {
  const filed = (taskId: string, name: string) => ({
    id: `doc-${name}` as never,
    officeId: "office-acme" as never,
    ownerKind: "task" as const,
    ownerId: taskId,
    tray: "out" as const,
    name,
    mediaType: "text/markdown",
    size: 4,
    blobRef: `office-acme/documents/doc-${name}`,
    addedBy: null,
    addedAt: new Date("2026-09-29T09:00:00Z"),
  });

  it("shows nothing when they have produced nothing, rather than an empty box", () => {
    expect(screen.queryByRole("group", { name: /produced/i })).toBeNull();
  });

  it("surfaces documents that belong to their work, which no tray would show", () => {
    // Everything an agent files is owned by the task, so without this the
    // canvas shows none of what the office actually produced.
    act(() => {
      store.getState().load(
        store.getState().departments,
        store.getState().employees,
        [
          {
            id: "task-1",
            officeId: "office-acme",
            departmentId: eng.id,
            title: "Write the parser",
            assigneeId: ada.id,
            status: "in_progress",
          } as never,
        ],
        [],
      );
      store.getState().loadDocuments([filed("task-1", "parser-notes.md")]);
    });

    const produced = screen.getByRole("group", { name: /produced by their work/i });
    expect(produced).toHaveTextContent("parser-notes.md");
    expect(produced).toHaveTextContent("Write the parser");
  });
});

describe("what one person may use", () => {
  const web: Connector = {
    id: "conn-web" as ConnectorId,
    officeId,
    kind: "web",
    name: "design-web",
    config: { hosts: ["help.figma.com"] },
    secretRef: null,
    tools: ["fetch_url"],
    enabled: true,
    createdAt: at,
  };

  const opened = (department: Department = eng) => {
    view.unmount();
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([department], [ada, grace]);
    store.getState().loadConnectors([web]);
    store.getState().selectEmployee(ada.id);
    view = render(<EmployeeDrawer store={store} />);
    return screen.getByRole("group", { name: /what they may use/i });
  };

  const mine = (): readonly { connectorId: string; tool: string }[] =>
    store.getState().employees.find((one) => one.id === ada.id)?.toolGrants ?? [];

  it("grants one to this person alone, and saves it", async () => {
    const grants = opened();
    const user = userEvent.setup();
    await user.click(within(grants).getByRole("checkbox", { name: /everything/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(mine()).toEqual([{ connectorId: "conn-web", tool: "*" }]);
  });

  it("shows what their department gives everybody as already given", () => {
    const grants = opened({ ...eng, toolGrants: [{ connectorId: "conn-web", tool: "*" }] });
    const box = within(grants).getByRole("checkbox", { name: /everything/i });

    expect(box).toBeChecked();
    // Union, not override: there is no way to take a room's grant off a person.
    expect(box).toBeDisabled();
  });

  it("does not copy the department's grant onto the person when saving", async () => {
    // Copied over it would outlive the department's, and taking it off the
    // department would stop meaning anything.
    opened({ ...eng, toolGrants: [{ connectorId: "conn-web", tool: "*" }] });
    await userEvent.setup().click(screen.getByRole("button", { name: /save/i }));

    expect(mine()).toEqual([]);
  });
});

describe("pausing one person", () => {
  const control = () => screen.getByRole("group", { name: /whether this person picks up work/i });
  const them = () => store.getState().employees.find((one) => one.id === ada.id);

  it("offers the switch", () => {
    expect(control()).toBeTruthy();
  });

  it("pauses them the moment it is pressed", async () => {
    const user = userEvent.setup();
    await user.click(within(control()).getByRole("checkbox"));

    expect(them()?.status).toBe("paused");
  });

  it("puts them back to work", async () => {
    const user = userEvent.setup();
    await user.click(within(control()).getByRole("checkbox"));
    await user.click(within(control()).getByRole("checkbox"));

    expect(them()?.status).toBe("active");
  });

  it("stays paused when the drawer is cancelled", async () => {
    const user = userEvent.setup();
    await user.click(within(control()).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(them()?.status).toBe("paused");
  });

  it("does not offer to end somebody's employment", () => {
    // Terminating is final. A settings panel beside a model dropdown is not
    // where that belongs, and a disabled control would imply it could be undone.
    expect(screen.queryByText(/terminate/i)).toBeNull();
  });

  it("says a terminated person is, rather than offering a switch", () => {
    view.unmount();
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([eng], [{ ...ada, status: "terminated" }, grace]);
    store.getState().selectEmployee(ada.id);
    view = render(<EmployeeDrawer store={store} />);

    expect(screen.queryByRole("group", { name: /picks up work/i })).toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent(/no longer works here|terminated/i);
  });
});

describe("teaching somebody on their own panel", () => {
  const saved = () => store.getState().employees.find((one) => one.id === ada.id);

  it("writes a paragraph of standing instructions", async () => {
    const user = userEvent.setup();

    await user.type(
      screen.getByLabelText("How they work"),
      "Always check the order number before replying.",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(saved()?.instructions).toBe("Always check the order number before replying.");
  });

  it("shows what somebody was already told", () => {
    view.unmount();
    const taught = unwrap(
      updateEmployee(ada, { instructions: "Write in short paragraphs." }, { supervisor: null }),
    );
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([eng], [taught, grace]);
    store.getState().selectEmployee(ada.id);
    render(<EmployeeDrawer store={store} />);

    expect(screen.getByLabelText("How they work")).toHaveValue("Write in short paragraphs.");
  });

  it("unteaches somebody when the paragraph is cleared", async () => {
    view.unmount();
    const taught = unwrap(
      updateEmployee(ada, { instructions: "Forget this." }, { supervisor: null }),
    );
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([eng], [taught, grace]);
    store.getState().selectEmployee(ada.id);
    render(<EmployeeDrawer store={store} />);
    const user = userEvent.setup();

    await user.clear(screen.getByLabelText("How they work"));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(store.getState().employees.find((one) => one.id === ada.id)?.instructions).toBeNull();
  });

  it("says where instructions stop and a skill begins", () => {
    // Without this, every skill in the office ends up pasted into somebody's
    // instructions — and so does everything they were ever told once.
    const drawer = screen.getByRole("dialog");

    expect(drawer).toHaveTextContent(/skill/i);
    expect(drawer).toHaveTextContent(/learn/i);
  });

  it("adds an example of what good looks like", async () => {
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("When"), "an angry customer");
    await user.type(screen.getByLabelText("What good looks like"), "Thank you for flagging this.");
    await user.click(screen.getByRole("button", { name: "Add example" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(saved()?.examples).toEqual([
      { when: "an angry customer", good: "Thank you for flagging this." },
    ]);
  });

  it("will not add an example with no work in it", async () => {
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("When"), "a situation and nothing else");

    expect(screen.getByRole("button", { name: "Add example" })).toBeDisabled();
  });

  it("takes an example away again", async () => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("What good looks like"), "Short. Specific.");
    await user.click(screen.getByRole("button", { name: "Add example" }));

    await user.click(screen.getByRole("button", { name: /remove example/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(saved()?.examples).toEqual([]);
  });

  it("keeps an example out of the office until the panel is saved", async () => {
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("What good looks like"), "Not saved yet.");
    await user.click(screen.getByRole("button", { name: "Add example" }));

    expect(saved()?.examples).toEqual([]);
  });

  it("says what was wrong rather than saving a paragraph nobody could have meant", async () => {
    const user = userEvent.setup();
    const field = screen.getByLabelText("How they work");

    // Typed rather than pasted would take a minute; this is the same thing.
    await act(async () => {
      await user.click(field);
    });
    await user.paste("x".repeat(20_001));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/instructions/i);
    expect(saved()?.instructions).toBeNull();
  });
});

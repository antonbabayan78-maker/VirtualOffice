import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createDepartment,
  unwrap,
  type Connector,
  type ConnectorId,
  type Department,
  type DepartmentId,
  type OfficeId,
} from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { DepartmentDrawer } from "./DepartmentDrawer.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-28T09:00:00Z");

const make = (id: string, name: string): Department =>
  unwrap(
    createDepartment({ officeId, name, color: "#3366ff", position: { x: 0, y: 0 } }, [], {
      id: () => id as DepartmentId,
      now: () => at,
    }),
  );

const eng = make("dept-eng", "Engineering");
const sales = make("dept-sales", "Sales");

let store: OfficeStore;
let view: ReturnType<typeof render>;

function open(selected: DepartmentId | null = eng.id) {
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().load([eng, sales], []);
  if (selected !== null) store.getState().select(selected);
  return render(<DepartmentDrawer store={store} />);
}

const saved = (): Department | undefined =>
  store.getState().departments.find((d) => d.id === eng.id);

beforeEach(() => {
  view = open();
});

describe("the department drawer", () => {
  it("stays shut until a department is selected", () => {
    view.unmount();
    open(null);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on the department that was selected", () => {
    expect(screen.getByRole("dialog", { name: /Engineering/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Engineering");
  });

  it("renames a department", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Platform");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.name).toBe("Platform");
  });

  it("refuses a name another department already has, and says so", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Sales");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/already exists/i);
    expect(saved()?.name).toBe("Engineering");
  });

  it("lets a department keep its own name", async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saved()?.name).toBe("Engineering");
  });
});

describe("choosing how work gets reviewed", () => {
  const policy = (): HTMLElement => screen.getByLabelText("Review policy");

  it("offers every policy the engine can actually run", () => {
    const kinds = [...policy().querySelectorAll("option")].map((o) => o.getAttribute("value"));
    expect(kinds).toEqual(["direct", "manager", "peer", "quorum", "pipeline", "automated", "gate"]);
  });

  it("explains what the chosen one does", () => {
    expect(screen.getByRole("dialog")).toHaveTextContent(/supervisor/i);
  });

  it("asks only for the settings that policy needs", async () => {
    const user = userEvent.setup();
    expect(screen.getByLabelText("Rounds before escalating")).toBeInTheDocument();
    await user.selectOptions(policy(), "direct");
    expect(screen.queryByLabelText("Rounds before escalating")).toBeNull();
  });

  it("switches to nobody reviewing anything", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "direct");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.reviewPolicy).toEqual({ kind: "direct" });
  });

  it("takes a quorum and how many must agree", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "quorum");
    await user.clear(screen.getByLabelText("Approvals required"));
    await user.type(screen.getByLabelText("Approvals required"), "3");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.reviewPolicy).toMatchObject({ kind: "quorum", required: 3 });
  });

  it("takes the check an automated reviewer runs", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "automated");
    await user.clear(screen.getByLabelText("Check to run"));
    await user.type(screen.getByLabelText("Check to run"), "unit-tests");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.reviewPolicy).toMatchObject({ kind: "automated", checkId: "unit-tests" });
  });

  it("takes the categories a human gate holds", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "gate");
    await user.click(screen.getByRole("checkbox", { name: "deploy" }));
    await user.click(screen.getByRole("checkbox", { name: "delete" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.reviewPolicy).toMatchObject({
      kind: "gate",
      gatedActions: ["deploy", "delete"],
    });
  });

  it("will not save a gate that gates nothing", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "gate");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one/i);
  });

  it("builds a pipeline out of named stages, in order", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "pipeline");
    await user.clear(screen.getByLabelText("New stage"));
    await user.type(screen.getByLabelText("New stage"), "Draft");
    await user.click(screen.getByRole("button", { name: /add stage/i }));
    await user.clear(screen.getByLabelText("New stage"));
    await user.type(screen.getByLabelText("New stage"), "Legal");
    await user.click(screen.getByRole("button", { name: /add stage/i }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    const policySaved = saved()?.reviewPolicy;
    expect(policySaved?.kind).toBe("pipeline");
    if (policySaved?.kind === "pipeline") {
      expect(policySaved.stages.map((stage) => stage.name)).toEqual(["Draft", "Legal"]);
    }
  });

  it("will not save a pipeline with no stages", async () => {
    const user = userEvent.setup();
    await user.selectOptions(policy(), "pipeline");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/at least one stage/i);
  });
});

describe("the rest of a department", () => {
  it("takes an icon and gives it back", async () => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Icon"), "wrench");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.icon).toBe("wrench");

    act(() => {
      store.getState().select(eng.id);
    });
    await user.clear(screen.getByLabelText("Icon"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.icon).toBeNull();
  });

  it("gives a department hours of its own", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Working hours"), "own");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(saved()?.schedule).toMatchObject({ kind: "windows" });
  });

  it("closes on Cancel without keeping anything", async () => {
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Abandoned");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(store.getState().selectedId).toBeNull();
    expect(saved()?.name).toBe("Engineering");
  });
});

describe("a department's standing priority", () => {
  it("shows what it is set to", () => {
    expect(screen.getByLabelText(/priority/i)).toHaveValue("normal");
  });

  it("puts a department into crunch", async () => {
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/priority/i), "urgent");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(saved()?.priority).toBe("urgent");
  });

  it("offers every priority the office understands", () => {
    const options = Array.from(
      screen.getByLabelText(/priority/i).querySelectorAll("option"),
      (option) => option.value,
    );
    expect(options).toEqual(["low", "normal", "high", "urgent"]);
  });

  it("says what setting it actually does, since it outranks the tasks below it", () => {
    expect(screen.getByText(/ahead of|outranks|before other departments/i)).toBeTruthy();
  });
});

describe("what this department expects of everything it makes", () => {
  it("shows what it already expects", () => {
    expect(screen.getByText(/nothing yet|expects nothing/i)).toBeTruthy();
  });

  it("takes a new expectation", async () => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/new expectation/i), "the tests cover the error path");
    await user.click(screen.getByRole("button", { name: /add expectation/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(saved()?.definitionOfDone).toEqual(["the tests cover the error path"]);
  });

  it("will not add an empty one", () => {
    expect(screen.getByRole("button", { name: /add expectation/i })).toBeDisabled();
  });

  it("takes one away again", async () => {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/new expectation/i), "has tests");
    await user.click(screen.getByRole("button", { name: /add expectation/i }));
    await user.click(screen.getByRole("button", { name: /remove has tests/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(saved()?.definitionOfDone).toEqual([]);
  });

  it("says what the list is for, since it decides when work is done", () => {
    expect(screen.getByText(/done|acceptable|finished/i)).toBeTruthy();
  });
});

describe("what is in the room's trays", () => {
  it("shows both, so a person can give the department something to work from", () => {
    expect(screen.getByRole("group", { name: /in-tray for department/i })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: /out-tray for department/i })).toBeInTheDocument();
  });
});

describe("what the room's work has produced", () => {
  it("shows nothing until some work has produced something", () => {
    expect(screen.queryByRole("group", { name: /produced here/i })).toBeNull();
  });
});

describe("what a department may use", () => {
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

  const withConnector = () => {
    view.unmount();
    view = open();
    act(() => {
      store.getState().loadConnectors([web]);
    });
  };

  it("offers the office's connectors", () => {
    withConnector();
    const grants = screen.getByRole("group", { name: /what this department may use/i });
    expect(within(grants).getByRole("group", { name: "design-web" })).toBeTruthy();
  });

  it("grants one, and saves it with the rest of the department", async () => {
    withConnector();
    const user = userEvent.setup();
    const grants = screen.getByRole("group", { name: /what this department may use/i });
    await user.click(within(grants).getByRole("checkbox", { name: /everything/i }));
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(saved()?.toolGrants).toEqual([{ connectorId: "conn-web", tool: "*" }]);
  });

  it("changes nothing when the edit is abandoned", async () => {
    withConnector();
    const user = userEvent.setup();
    const grants = screen.getByRole("group", { name: /what this department may use/i });
    await user.click(within(grants).getByRole("checkbox", { name: /everything/i }));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(saved()?.toolGrants).toEqual([]);
  });

  it("keeps a grant it already had when something else is saved", async () => {
    // The draft carries them; a save that left toolGrants out would clear them.
    view.unmount();
    store = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    store.getState().load([{ ...eng, toolGrants: [{ connectorId: "conn-web", tool: "*" }] }], []);
    store.getState().loadConnectors([web]);
    store.getState().select(eng.id);
    view = render(<DepartmentDrawer store={store} />);

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(/priority/i), "urgent");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(saved()?.toolGrants).toEqual([{ connectorId: "conn-web", tool: "*" }]);
  });
});

describe("stopping one department", () => {
  const control = () =>
    screen.getByRole("group", { name: /whether this department picks up work/i });

  it("offers the switch", () => {
    expect(control()).toBeTruthy();
  });

  it("stops the room the moment it is pressed", async () => {
    const user = userEvent.setup();
    await user.click(within(control()).getByRole("checkbox"));

    expect(saved()?.runState).toBe("paused");
  });

  it("leaves the other rooms working", async () => {
    const user = userEvent.setup();
    await user.click(within(control()).getByRole("checkbox"));

    expect(store.getState().departments.find((d) => d.id === sales.id)?.runState).toBe("running");
  });

  it("stays stopped when the drawer is cancelled", async () => {
    const user = userEvent.setup();
    await user.click(within(control()).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(saved()?.runState).toBe("paused");
  });
});

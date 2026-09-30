import { beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connector, ConnectorId, Office, OfficeId } from "@vo/core";
import { createOfficeStore, type OfficeStore } from "../office/office-store.js";
import { Connectors } from "./Connectors.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-30T09:00:00Z");

const acme: Office = {
  id: officeId,
  name: "Acme Robotics",
  schedule: { kind: "always" },
  priority: "normal",
  runState: "running",
  configVersion: 1,
  createdAt: at,
};

const web = (overrides: Partial<Connector> = {}): Connector => ({
  id: "conn-web" as ConnectorId,
  officeId,
  kind: "web",
  name: "design-web",
  config: { hosts: ["help.figma.com"] },
  secretRef: null,
  tools: ["fetch_url"],
  enabled: true,
  createdAt: at,
  ...overrides,
});

let store: OfficeStore;
/** What the office was asked to do, so a click is checked by its effect. */
let asked: { what: string; body: unknown }[];

function open(connectors: readonly Connector[] = [], answers: Record<string, unknown> = {}) {
  // Re-opened inside a test as well as in beforeEach, and two panels in one
  // container would make every query ambiguous.
  cleanup();
  asked = [];
  store = createOfficeStore({
    storage: { readLayout: () => null, writeLayout: () => undefined },
    id: () => "new",
    now: () => at,
  });
  store.getState().loadOffice(acme);
  store.getState().loadConnectors(connectors);
  store.getState().connect({
    createConnector: (_officeId: string, input: Record<string, unknown>) => {
      asked.push({ what: "create", body: input });
      return Promise.resolve(
        answers["create"] ?? { ok: true, value: web({ id: "conn-new" as ConnectorId, ...input }) },
      );
    },
    patchConnector: (id: string, changes: Record<string, unknown>) => {
      asked.push({ what: "patch", body: { id, changes } });
      return Promise.resolve(
        answers["patch"] ?? {
          ok: true,
          value: { ...(connectors.find((one) => one.id === id) ?? web()), ...changes },
        },
      );
    },
    deleteConnector: (id: string) => {
      asked.push({ what: "delete", body: id });
      return Promise.resolve(answers["delete"] ?? { ok: true, value: true });
    },
  } as never);
  return render(<Connectors store={store} />);
}

const panel = () => screen.getByRole("group", { name: /what this office can reach/i });
const row = (name: string) => within(panel()).getByRole("group", { name });

beforeEach(() => {
  open();
});

describe("the connectors an office has", () => {
  it("says it reaches nothing when it reaches nothing", () => {
    // Not an empty list: an office with no connectors is a fact worth stating,
    // because the grants sections elsewhere will be empty for this reason.
    expect(panel()).toHaveTextContent(/nothing outside/i);
  });

  it("lists what it has, by name", () => {
    open([web({ id: "conn-ops" as ConnectorId, name: "ops-web" }), web()]);
    const names = within(panel())
      .getAllByRole("group")
      .map((one) => one.getAttribute("aria-label"));

    expect(names).toEqual(["design-web", "ops-web"]);
  });

  it("says what kind of thing each one is", () => {
    open([web()]);
    expect(row("design-web")).toHaveTextContent(/web/i);
  });

  it("shows the hosts it may read", () => {
    open([web()]);
    expect(row("design-web")).toHaveTextContent("help.figma.com");
  });

  it("says a connector with no hosts reaches nothing, rather than everything", () => {
    // parseAllowlist allows nothing when it is given nothing; a panel that said
    // nothing here would read as "no restrictions".
    open([web({ config: {} })]);
    expect(row("design-web")).toHaveTextContent(/no hosts|reaches nothing/i);
  });
});

describe("switching a connector off", () => {
  it("tells the office, and shows it off at once", async () => {
    const user = userEvent.setup();
    open([web()]);
    await user.click(within(row("design-web")).getByRole("checkbox", { name: /on/i }));

    expect(asked).toEqual([
      { what: "patch", body: { id: "conn-web", changes: { enabled: false } } },
    ]);
    expect(store.getState().connectors[0]?.enabled).toBe(false);
  });

  it("shows a switched-off one as off, and switches it back on", async () => {
    const user = userEvent.setup();
    open([web({ enabled: false })]);
    const toggle = within(row("design-web")).getByRole("checkbox", { name: /on/i });
    expect(toggle).not.toBeChecked();

    await user.click(toggle);
    expect(asked[0]).toEqual({
      what: "patch",
      body: { id: "conn-web", changes: { enabled: true } },
    });
  });

  it("says a switched-off one grants nothing while it is off", () => {
    open([web({ enabled: false })]);
    expect(row("design-web")).toHaveTextContent(/off/i);
  });
});

describe("the hosts a connector may read", () => {
  it("adds one", async () => {
    const user = userEvent.setup();
    open([web()]);
    await user.type(within(row("design-web")).getByLabelText(/new host/i), "www.w3.org");
    await user.click(within(row("design-web")).getByRole("button", { name: /add host/i }));

    expect(asked).toEqual([
      {
        what: "patch",
        body: { id: "conn-web", changes: { config: { hosts: ["help.figma.com", "www.w3.org"] } } },
      },
    ]);
  });

  it("keeps the rest of the configuration when it adds one", async () => {
    // Replacing config wholesale would quietly drop allowPlainHttp and anything
    // a later kind puts there.
    const user = userEvent.setup();
    open([web({ config: { hosts: [], allowPlainHttp: true } })]);
    await user.type(within(row("design-web")).getByLabelText(/new host/i), "acme.test");
    await user.click(within(row("design-web")).getByRole("button", { name: /add host/i }));

    expect(
      (asked[0]?.body as { changes: { config: Record<string, unknown> } }).changes.config,
    ).toEqual({ hosts: ["acme.test"], allowPlainHttp: true });
  });

  it("will not add the same host twice", async () => {
    const user = userEvent.setup();
    open([web()]);
    await user.type(within(row("design-web")).getByLabelText(/new host/i), "help.figma.com");
    await user.click(within(row("design-web")).getByRole("button", { name: /add host/i }));

    expect(asked).toEqual([]);
  });

  it("takes one away", async () => {
    const user = userEvent.setup();
    open([web()]);
    await user.click(
      within(row("design-web")).getByRole("button", { name: /remove help\.figma\.com/i }),
    );

    expect(asked).toEqual([
      { what: "patch", body: { id: "conn-web", changes: { config: { hosts: [] } } } },
    ]);
  });

  it("does not offer to add nothing", () => {
    open([web()]);
    expect(within(row("design-web")).getByRole("button", { name: /add host/i })).toBeDisabled();
  });
});

describe("adding a connector", () => {
  const add = async (name: string) => {
    const user = userEvent.setup();
    await user.type(within(panel()).getByLabelText(/new connector/i), name);
    await user.click(within(panel()).getByRole("button", { name: /add connector/i }));
    return user;
  };

  it("asks the office to make one, with the tools its kind offers", async () => {
    open();
    await add("design-web");

    expect(asked).toEqual([
      {
        what: "create",
        body: { kind: "web", name: "design-web", tools: ["fetch_url"], config: { hosts: [] } },
      },
    ]);
  });

  it("shows it once the office has made it", async () => {
    open();
    await add("design-web");
    expect(store.getState().connectors).toHaveLength(1);
  });

  it("clears the name it used, so the next one starts empty", async () => {
    open();
    await add("design-web");
    expect(within(panel()).getByLabelText(/new connector/i)).toHaveValue("");
  });

  it("does not offer to add one with no name", () => {
    open();
    expect(within(panel()).getByRole("button", { name: /add connector/i })).toBeDisabled();
  });

  it("shows what the office refused, and keeps what was typed", async () => {
    open([], {
      create: {
        ok: false,
        kind: "validation",
        errors: [{ path: "name", message: "must be a kebab-case identifier" }],
      },
    });
    await add("Design Web");

    expect(within(panel()).getByRole("alert")).toHaveTextContent(/kebab-case/i);
    expect(within(panel()).getByLabelText(/new connector/i)).toHaveValue("Design Web");
  });

  it("offers only kinds this office can actually perform", () => {
    // An MCP connector added here would be granted and then perform nothing.
    open();
    expect(within(panel()).queryByText(/\bmcp\b/i)).toBeNull();
  });
});

describe("removing a connector", () => {
  it("asks the office to, and takes it off the panel", async () => {
    const user = userEvent.setup();
    open([web()]);
    await user.click(within(row("design-web")).getByRole("button", { name: /remove design-web/i }));

    expect(asked).toEqual([{ what: "delete", body: "conn-web" }]);
    expect(store.getState().connectors).toEqual([]);
  });

  it("says what happened when the office would not", async () => {
    const user = userEvent.setup();
    open([web()], { delete: { ok: false, kind: "transport", message: "unreachable" } });
    await user.click(within(row("design-web")).getByRole("button", { name: /remove design-web/i }));

    expect(store.getState().connectors).toHaveLength(1);
  });
});

describe("a canvas with no office", () => {
  it("shows nothing at all, rather than a panel that cannot save", () => {
    cleanup();
    const empty = createOfficeStore({
      storage: { readLayout: () => null, writeLayout: () => undefined },
      id: () => "new",
      now: () => at,
    });
    render(<Connectors store={empty} />);
    expect(screen.queryByRole("group")).toBeNull();
  });
});

describe("keeping the panel honest", () => {
  it("does not send a change twice when a click is repeated fast", async () => {
    const user = userEvent.setup();
    open([web()]);
    const toggle = within(row("design-web")).getByRole("checkbox", { name: /on/i });
    await user.click(toggle);
    await user.click(toggle);

    // Two clicks, two changes, and the second one is the opposite of the first.
    expect(asked.map((one) => (one.body as { changes: unknown }).changes)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
  });

  it("does not ask the office anything on first render", () => {
    open([web()]);
    expect(asked).toEqual([]);
  });
});

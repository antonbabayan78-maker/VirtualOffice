import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Connector, ConnectorId, OfficeId, ToolGrant } from "@vo/core";
import { Grants } from "./Grants.js";

const officeId = "office-acme" as OfficeId;
const at = new Date("2026-09-30T09:00:00Z");

const connector = (
  id: string,
  name: string,
  tools: readonly string[],
  overrides: Partial<Connector> = {},
): Connector => ({
  id: id as ConnectorId,
  officeId,
  kind: "web",
  name,
  config: { hosts: ["help.figma.com"] },
  secretRef: null,
  tools,
  enabled: true,
  createdAt: at,
  ...overrides,
});

const figma = connector("conn-figma", "figma", ["get_file", "post_comment"]);
const web = connector("conn-web", "design-web", ["fetch_url"]);

interface Options {
  readonly connectors?: readonly Connector[];
  readonly grants?: readonly ToolGrant[];
  readonly inherited?: readonly ToolGrant[];
  readonly owner?: "department" | "employee";
}

function mount({
  connectors = [figma],
  grants = [],
  inherited,
  owner = "department",
}: Options = {}) {
  cleanup();
  const onChange = vi.fn();
  render(
    <Grants
      connectors={connectors}
      grants={grants}
      {...(inherited === undefined ? {} : { inherited })}
      owner={owner}
      onChange={onChange}
    />,
  );
  return onChange;
}

const panel = () => screen.getByRole("group", { name: /may use/i });
const row = (name: string) => within(panel()).getByRole("group", { name });
const everything = (name: string) =>
  within(row(name)).getByRole("checkbox", { name: /everything/i });

describe("what a department may use", () => {
  it("offers the office's own connectors, not free text", () => {
    // A typed connector id is a grant that names nothing, which the office now
    // refuses — so the only safe control is one that cannot express it.
    mount({ connectors: [figma, web] });
    expect(within(panel()).queryByRole("textbox")).toBeNull();
    expect(
      within(panel())
        .getAllByRole("group")
        .map((one) => one.getAttribute("aria-label")),
    ).toEqual(["figma", "design-web"]);
  });

  it("says where to add one when the office reaches nothing", () => {
    // Not hidden: somebody looking for "let Design use Figma" needs to be told
    // that the office has nothing to grant and where that is fixed.
    mount({ connectors: [] });
    expect(panel()).toHaveTextContent(/office panel/i);
  });

  it("shows nothing ticked when nothing is granted", () => {
    mount();
    expect(everything("figma")).not.toBeChecked();
  });

  it("grants everything a connector offers with one tick", () => {
    const onChange = mount();
    return userEvent
      .setup()
      .click(everything("figma"))
      .then(() => {
        expect(onChange).toHaveBeenCalledWith([{ connectorId: "conn-figma", tool: "*" }]);
      });
  });

  it("shows a wildcard grant as everything, without listing it as a tool", () => {
    mount({ grants: [{ connectorId: "conn-figma", tool: "*" }] });
    expect(everything("figma")).toBeChecked();
  });

  it("takes the whole connector away when everything is unticked", async () => {
    const onChange = mount({ grants: [{ connectorId: "conn-figma", tool: "*" }] });
    await userEvent.setup().click(everything("figma"));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("leaves other connectors' grants alone", async () => {
    const onChange = mount({
      connectors: [figma, web],
      grants: [{ connectorId: "conn-web", tool: "*" }],
    });
    await userEvent.setup().click(everything("figma"));

    expect(onChange).toHaveBeenCalledWith([
      { connectorId: "conn-web", tool: "*" },
      { connectorId: "conn-figma", tool: "*" },
    ]);
  });
});

describe("granting single tools", () => {
  const openTools = async (name = "figma") => {
    const user = userEvent.setup();
    await user.click(within(row(name)).getByRole("button", { name: /choose tools/i }));
    return user;
  };

  it("keeps the tools out of the way until they are asked for", () => {
    // A connector that offers forty tools must not make this panel forty rows
    // long, which MCP will.
    mount();
    expect(within(row("figma")).queryByRole("checkbox", { name: /get_file/i })).toBeNull();
  });

  it("lists what the connector offers when they are asked for", async () => {
    mount();
    await openTools();
    expect(within(row("figma")).getByRole("checkbox", { name: /get_file/i })).toBeTruthy();
  });

  it("grants one tool on its own", async () => {
    const onChange = mount();
    const user = await openTools();
    await user.click(within(row("figma")).getByRole("checkbox", { name: /get_file/i }));

    expect(onChange).toHaveBeenCalledWith([{ connectorId: "conn-figma", tool: "get_file" }]);
  });

  it("takes one away again", async () => {
    const onChange = mount({ grants: [{ connectorId: "conn-figma", tool: "get_file" }] });
    const user = await openTools();
    await user.click(within(row("figma")).getByRole("checkbox", { name: /get_file/i }));

    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("shows a tool a wildcard already covers as granted, and not changeable", async () => {
    // Ticking it would add a grant that changes nothing, and unticking it would
    // look like it took something away.
    mount({ grants: [{ connectorId: "conn-figma", tool: "*" }] });
    await openTools();
    const tool = within(row("figma")).getByRole("checkbox", { name: /get_file/i });

    expect(tool).toBeChecked();
    expect(tool).toBeDisabled();
  });

  it("drops the single grants when everything is ticked", async () => {
    // Keeping both would leave a grant that says nothing, and unticking
    // everything later would silently leave that one behind.
    const onChange = mount({ grants: [{ connectorId: "conn-figma", tool: "get_file" }] });
    await userEvent.setup().click(everything("figma"));

    expect(onChange).toHaveBeenCalledWith([{ connectorId: "conn-figma", tool: "*" }]);
  });

  it("shows how many of a connector's tools are granted", () => {
    mount({ grants: [{ connectorId: "conn-figma", tool: "get_file" }] });
    expect(row("figma")).toHaveTextContent(/1 of 2/i);
  });
});

describe("a connector that is switched off", () => {
  it("says so, since the grant will do nothing meanwhile", () => {
    mount({ connectors: [connector("conn-figma", "figma", ["get_file"], { enabled: false })] });
    expect(row("figma")).toHaveTextContent(/off/i);
  });

  it("can still be granted, so it works the moment it comes back on", async () => {
    const onChange = mount({
      connectors: [connector("conn-figma", "figma", ["get_file"], { enabled: false })],
    });
    await userEvent.setup().click(everything("figma"));
    expect(onChange).toHaveBeenCalledWith([{ connectorId: "conn-figma", tool: "*" }]);
  });
});

describe("what a person inherits from their department", () => {
  const inherited = [{ connectorId: "conn-figma", tool: "*" }];

  it("shows the department's grant as already given", () => {
    mount({ owner: "employee", inherited });
    expect(everything("figma")).toBeChecked();
  });

  it("does not let it be taken away here, because the model is union", () => {
    // An employee's grants add to their department's; there is no way to
    // subtract one, so an unticked box would be a lie.
    mount({ owner: "employee", inherited });
    expect(everything("figma")).toBeDisabled();
  });

  it("says where it came from", () => {
    mount({ owner: "employee", inherited });
    expect(row("figma")).toHaveTextContent(/department/i);
  });

  it("shows one inherited tool without locking the others", async () => {
    const onChange = mount({
      owner: "employee",
      inherited: [{ connectorId: "conn-figma", tool: "get_file" }],
    });
    const user = userEvent.setup();
    await user.click(within(row("figma")).getByRole("button", { name: /choose tools/i }));

    expect(within(row("figma")).getByRole("checkbox", { name: /get_file/i })).toBeDisabled();
    const other = within(row("figma")).getByRole("checkbox", { name: /post_comment/i });
    expect(other).not.toBeChecked();

    await user.click(other);
    expect(onChange).toHaveBeenCalledWith([{ connectorId: "conn-figma", tool: "post_comment" }]);
  });

  it("does not report the department's grants as the person's own", async () => {
    // The department grant is not in `grants`, and adding it to what comes back
    // would copy it onto the person — where it would outlive the department's.
    const onChange = mount({
      owner: "employee",
      inherited: [{ connectorId: "conn-figma", tool: "get_file" }],
      connectors: [figma, web],
    });
    await userEvent.setup().click(everything("design-web"));

    expect(onChange).toHaveBeenCalledWith([{ connectorId: "conn-web", tool: "*" }]);
  });

  it("says a department's grants reach everybody in it", () => {
    mount({ owner: "department" });
    expect(panel()).toHaveTextContent(/everyone/i);
  });
});

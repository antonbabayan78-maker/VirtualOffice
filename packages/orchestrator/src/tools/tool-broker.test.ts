import { describe, expect, it } from "vitest";
import {
  createConnector,
  unwrap,
  type Connector,
  type ConnectorId,
  type OfficeId,
  type ToolGrant,
} from "@vo/core";
import { catalogFor, describedTool, recordingToolBroker } from "./tool-broker.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-09-30T09:00:00Z");

const connector = (name: string, tools: string[], enabled = true): Connector => ({
  ...unwrap(
    createConnector({ officeId, kind: "rest", name, tools }, [], {
      id: () => `conn-${name}` as ConnectorId,
      now: () => at,
    }),
  ),
  enabled,
});

const web = connector("web", ["fetch_url", "check_status"]);
const figma = connector("figma", ["get_file", "list_projects"]);

const described = [
  describedTool(web.id, "fetch_url", "Fetch a page."),
  describedTool(web.id, "check_status", "Check whether a page answers."),
  describedTool(figma.id, "get_file", "Read a Figma file."),
  describedTool(figma.id, "list_projects", "List Figma projects."),
];

const namesIn = (
  connectors: readonly Connector[],
  departmentGrants: ToolGrant[],
  employeeGrants: ToolGrant[] = [],
): string[] =>
  catalogFor({ connectors, departmentGrants, employeeGrants }, described)
    .all()
    .map((tool) => tool.name);

describe("the tools one employee may call", () => {
  it("offers a tool the room was granted", () => {
    expect(namesIn([web], [{ connectorId: web.id, tool: "fetch_url" }])).toEqual([
      "web__fetch_url",
    ]);
  });

  it("does not offer one nobody was granted", () => {
    // The catalogue is what find_tool searches, so an ungranted tool must not be
    // in it — otherwise the model finds it, asks for it, and is refused.
    expect(namesIn([web], [{ connectorId: web.id, tool: "fetch_url" }])).not.toContain(
      "web__check_status",
    );
  });

  it("adds what this person was granted on top of what the room was", () => {
    const names = namesIn(
      [web, figma],
      [{ connectorId: web.id, tool: "fetch_url" }],
      [{ connectorId: figma.id, tool: "get_file" }],
    );
    expect(names.sort()).toEqual(["figma__get_file", "web__fetch_url"]);
  });

  it("gives a designer Figma and an engineer the web, from one office", () => {
    const designer = namesIn([web, figma], [{ connectorId: figma.id, tool: "*" }]);
    const engineer = namesIn([web, figma], [{ connectorId: web.id, tool: "*" }]);

    expect(designer.every((name) => name.startsWith("figma__"))).toBe(true);
    expect(engineer.every((name) => name.startsWith("web__"))).toBe(true);
  });

  it("takes everything a connector has when the grant is a wildcard", () => {
    expect(namesIn([web], [{ connectorId: web.id, tool: "*" }]).sort()).toEqual([
      "web__check_status",
      "web__fetch_url",
    ]);
  });

  it("offers nothing from a connector that is switched off", () => {
    expect(
      namesIn([connector("web", ["fetch_url"], false)], [{ connectorId: web.id, tool: "*" }]),
    ).toEqual([]);
  });

  it("offers nothing at all when nothing was granted", () => {
    expect(namesIn([web, figma], [])).toEqual([]);
  });

  it("cannot be talked into a tool the connector does not declare", () => {
    // The declared tool list is the bound, not the source. A connector that
    // starts reporting new tools cannot introduce one nobody granted.
    const drifting = [...described, describedTool(web.id, "post_form", "Submit a form.")];
    const catalogue = catalogFor(
      {
        connectors: [web],
        departmentGrants: [{ connectorId: web.id, tool: "*" }],
        employeeGrants: [],
      },
      drifting,
    );

    expect(catalogue.all().map((tool) => tool.name)).not.toContain("web__post_form");
  });

  it("leaves out a granted tool nobody can describe", () => {
    // Granted but not offered by the running connector: nothing to call.
    const catalogue = catalogFor(
      {
        connectors: [connector("web", ["fetch_url", "ghost"])],
        departmentGrants: [{ connectorId: web.id, tool: "*" }],
        employeeGrants: [],
      },
      described,
    );
    expect(catalogue.all().map((tool) => tool.name)).toEqual(["web__fetch_url"]);
  });

  it("keeps the connector on each tool, so a refusal can be worked out later", () => {
    const [tool] = catalogFor(
      {
        connectors: [web],
        departmentGrants: [{ connectorId: web.id, tool: "fetch_url" }],
        employeeGrants: [],
      },
      described,
    ).all();

    expect(tool?.connectorId).toBe(web.id);
  });

  it("carries the description through, which is all the model has to go on", () => {
    const [tool] = catalogFor(
      {
        connectors: [web],
        departmentGrants: [{ connectorId: web.id, tool: "fetch_url" }],
        employeeGrants: [],
      },
      described,
    ).all();

    expect(tool?.description).toBe("Fetch a page.");
  });
});

describe("a broker that keeps what it was asked", () => {
  it("records the call and answers with what it was told to", async () => {
    const { broker, calls } = recordingToolBroker({
      web__fetch_url: { summary: "Fetched one page." },
    });

    const outcome = await broker.call({ name: "web__fetch_url", input: { url: "https://x.test" } });

    expect(calls).toEqual([{ name: "web__fetch_url", input: { url: "https://x.test" } }]);
    expect(outcome.summary).toBe("Fetched one page.");
  });

  it("says so rather than inventing an answer for a call nobody scripted", async () => {
    const { broker } = recordingToolBroker({});
    await expect(broker.call({ name: "web__fetch_url", input: {} })).rejects.toThrow(/fetch_url/);
  });

  it("describes nothing unless it was given something to describe", async () => {
    const { broker } = recordingToolBroker({});
    expect(await broker.describe()).toEqual([]);
  });
});

describe("what a tool says it does, carried to the catalogue", () => {
  const sending = {
    ...describedTool(web.id, "fetch_url", "Fetch a page."),
    gates: ["external_send"] as const,
  };

  it("keeps the categories the connector declared, which is what the gate reads", () => {
    const catalog = catalogFor(
      {
        connectors: [web],
        departmentGrants: [{ connectorId: web.id, tool: "fetch_url" }],
        employeeGrants: [],
      },
      [sending],
    );

    expect(catalog.get("web__fetch_url")?.gates).toEqual(["external_send"]);
  });

  it("leaves a tool that declared nothing declaring nothing, so a quiet office stays quiet", () => {
    const catalog = catalogFor(
      {
        connectors: [web],
        departmentGrants: [{ connectorId: web.id, tool: "fetch_url" }],
        employeeGrants: [],
      },
      described,
    );

    expect(catalog.get("web__fetch_url")?.gates).toBeUndefined();
  });

  it("will not let a server introduce a tool nobody granted, however it describes it", () => {
    // The office wrote down which tools this connector has. A server that
    // starts reporting another one — destructive, in this case — is describing
    // something no grant names, and a wildcard grant is still bounded by the
    // written list.
    const surprise = {
      ...describedTool(web.id, "delete_everything", "Delete the lot."),
      gates: ["delete"] as const,
    };

    const catalog = catalogFor(
      {
        connectors: [web],
        departmentGrants: [{ connectorId: web.id, tool: "*" }],
        employeeGrants: [],
      },
      [...described, surprise],
    );

    expect(catalog.all().map((tool) => tool.name)).not.toContain("web__delete_everything");
  });
});

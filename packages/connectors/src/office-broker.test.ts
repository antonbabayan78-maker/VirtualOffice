import { describe, expect, it } from "vitest";
import { createConnector, unwrap, type Connector, type ConnectorId, type OfficeId } from "@vo/core";
import { officeBroker } from "./office-broker.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-09-30T09:00:00Z");

const connector = (
  name: string,
  kind: "web" | "mcp",
  config: Record<string, unknown> = {},
): Connector =>
  unwrap(
    createConnector({ officeId, kind, name, tools: ["fetch_url"], config }, [], {
      id: () => `conn-${name}` as ConnectorId,
      now: () => at,
    }),
  );

const page = () =>
  Promise.resolve(new Response("<p>Hello</p>", { headers: { "content-type": "text/html" } }));

describe("an office with more than one connector", () => {
  it("describes what every connector it understands can do", async () => {
    const broker = officeBroker(
      [
        connector("web-design", "web", { hosts: ["figma.com"] }),
        connector("web-ops", "web", { hosts: ["status.test"] }),
      ],
      { fetch: page },
    );

    const described = await broker.describe();
    expect(described.map((tool) => tool.connectorId).sort()).toEqual([
      "conn-web-design",
      "conn-web-ops",
    ]);
  });

  it("sends a call to the connector whose name it carries", async () => {
    const asked: string[] = [];
    const broker = officeBroker(
      [
        connector("web-design", "web", { hosts: ["figma.com"] }),
        connector("web-ops", "web", { hosts: ["status.test"] }),
      ],
      {
        fetch: (url) => {
          asked.push(url);
          return page();
        },
      },
    );

    await broker.call({ name: "web-ops__fetch_url", input: { url: "https://status.test/" } });
    expect(asked).toEqual(["https://status.test/"]);
  });

  it("keeps each connector to its own allowlist", async () => {
    // Two connectors of the same kind, different hosts, different grants: this
    // is what makes per-role access fall out of the model rather than needing
    // a new concept.
    const broker = officeBroker([connector("web-ops", "web", { hosts: ["status.test"] })], {
      fetch: page,
    });

    const outcome = await broker.call({
      name: "web-ops__fetch_url",
      input: { url: "https://figma.com/" },
    });
    expect(outcome.summary).toMatch(/does not allow/i);
  });

  it("says so for a connector this office does not have", async () => {
    const broker = officeBroker([connector("web", "web", { hosts: [] })], { fetch: page });
    await expect(broker.call({ name: "nope__fetch_url", input: {} })).rejects.toThrow(/nope/);
  });

  it("passes over a kind nothing can perform yet, rather than failing to start", async () => {
    // An office with an MCP connector configured is not an office that cannot
    // run; it is an office whose MCP tools are not available yet.
    const broker = officeBroker(
      [connector("figma", "mcp"), connector("web", "web", { hosts: [] })],
      {
        fetch: page,
      },
    );

    expect((await broker.describe()).map((tool) => tool.connectorId)).toEqual(["conn-web"]);
  });

  it("offers nothing at all for an office with no connectors", async () => {
    expect(await officeBroker([], { fetch: page }).describe()).toEqual([]);
  });

  it("leaves out a connector that is switched off", async () => {
    const off = { ...connector("web", "web", { hosts: ["acme.test"] }), enabled: false };
    expect(await officeBroker([off], { fetch: page }).describe()).toEqual([]);
  });
});

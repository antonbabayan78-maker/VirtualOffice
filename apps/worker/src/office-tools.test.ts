import { describe, expect, it } from "vitest";
import { createConnector, unwrap, type ConnectorId, type OfficeId } from "@vo/core";
import type { ApiClient } from "@vo/api-client";
import { officeTools } from "./office-tools.js";

const connector = {
  id: "conn-web",
  officeId: "office-1",
  kind: "web" as const,
  name: "design-web",
  config: { hosts: ["help.figma.com"] },
  secretRef: null,
  tools: ["fetch_url"],
  enabled: true,
  createdAt: new Date("2026-09-30T09:00:00Z"),
};

const api = (overrides: Partial<ApiClient> = {}): ApiClient => {
  const unused = () => Promise.reject(new Error("not used here"));
  return {
    loadOffice: unused,
    getOffice: unused,
    patchOffice: unused,
    getDepartment: unused,
    getEmployee: unused,
    getTask: unused,
    patchConnection: unused,
    patchDepartment: unused,
    patchEmployee: unused,
    postTaskEvent: unused,
    getDocument: unused,
    listDocuments: unused,
    uploadDocument: unused,
    downloadDocument: unused,
    deleteDocument: unused,
    listConnectors: () => Promise.resolve({ ok: true, value: [connector] }),
    createConnector: unused,
    patchConnector: unused,
    deleteConnector: unused,
    discoverConnectorTools: unused,
    ...overrides,
  } as ApiClient;
};

describe("a worker's reach", () => {
  it("describes what the office it serves can reach", async () => {
    const described = await officeTools(api(), "office-1").describe();
    expect(described.map((tool) => tool.name)).toEqual(["fetch_url"]);
  });

  it("can actually perform a call, which a broker built from nothing cannot", async () => {
    // The trap: the catalogue is built from the office's connectors while the
    // broker is built once at startup, before any office has been read. A
    // broker with no connectors offers tools it then refuses to perform.
    const tools = officeTools(api(), "office-1", {
      fetch: () =>
        Promise.resolve(new Response("<p>Hello</p>", { headers: { "content-type": "text/html" } })),
    });

    const outcome = await tools.call({
      name: "design-web__fetch_url",
      input: { url: "https://help.figma.com/states" },
    });
    expect(outcome.artifact?.content).toContain("Hello");
  });

  it("reaches nothing when the office cannot say what it has", async () => {
    const tools = officeTools(
      api({
        listConnectors: () =>
          Promise.resolve({ ok: false, kind: "transport", message: "no route" }),
      }),
      "office-1",
    );
    expect(await tools.describe()).toEqual([]);
  });

  it("asks the office again rather than remembering forever", async () => {
    // A connector switched off on the canvas should stop working without
    // restarting the worker.
    let asked = 0;
    const tools = officeTools(
      api({
        listConnectors: () => {
          asked += 1;
          return Promise.resolve({
            ok: true as const,
            value: asked === 1 ? [connector] : [],
          } as never);
        },
      }),
      "office-1",
    );

    expect(await tools.describe()).toHaveLength(1);
    expect(await tools.describe()).toEqual([]);
  });
});

describe("a connector the worker cannot reach", () => {
  it("says so, instead of a run quietly having no tools", async () => {
    // Until this, an MCP server that would not start meant a turn with an
    // empty catalogue and nothing in any log to explain it.
    const problems: string[] = [];
    const broken = unwrap(
      createConnector(
        {
          officeId: "office-1" as OfficeId,
          kind: "mcp",
          name: "acme",
          tools: ["send_email"],
          config: { command: "/definitely/not/a/program" },
        },
        [],
        { id: () => "conn-mcp" as ConnectorId, now: () => new Date("2026-10-03T09:00:00Z") },
      ),
    );

    const described = await officeTools(
      api({ listConnectors: () => Promise.resolve({ ok: true, value: [broken] }) }),
      "office-1",
      { onProblem: (message) => problems.push(message) },
    ).describe();

    expect(described).toEqual([]);
    expect(problems.join()).toContain("acme");
  });
});

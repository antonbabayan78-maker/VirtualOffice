import { describe, expect, it } from "vitest";
import type { OfficeId } from "../office/office.js";
import { isErr, isOk, unwrap } from "../shared/result.js";
import {
  canCallTool,
  CONNECTOR_KINDS,
  createConnector,
  resolveToolAccess,
  splitToolWireName,
  toolWireName,
  validateToolGrants,
  type Connector,
  type ConnectorId,
  type ToolGrant,
} from "./connector.js";

const officeId = "office-1" as OfficeId;
const now = new Date("2026-09-22T00:00:00Z");
let n = 0;
const deps = { id: () => `conn-${String(++n)}` as ConnectorId, now: () => now };

function connector(name: string, tools: string[], overrides: Partial<Connector> = {}): Connector {
  const c = unwrap(createConnector({ officeId, kind: "mcp", name, tools }, [], deps));
  return { ...c, ...overrides };
}

describe("createConnector", () => {
  it("lists the connector kinds", () => {
    expect(CONNECTOR_KINDS).toEqual(["web", "mcp", "rest", "webhook", "plugin"]);
  });

  it("creates an enabled connector with defaults", () => {
    const c = unwrap(
      createConnector({ officeId, kind: "mcp", name: "github", tools: ["get_diff"] }, [], deps),
    );
    expect(c).toEqual<Connector>({
      id: c.id,
      officeId,
      kind: "mcp",
      name: "github",
      config: {},
      secretRef: null,
      tools: ["get_diff"],
      enabled: true,
      createdAt: now,
    });
  });

  it("accepts config, a secret reference and enabled=false", () => {
    const c = unwrap(
      createConnector(
        {
          officeId,
          kind: "rest",
          name: "jira",
          tools: ["create_issue"],
          config: { baseUrl: "https://x" },
          secretRef: "vault://jira",
          enabled: false,
        },
        [],
        deps,
      ),
    );
    expect(c.config).toEqual({ baseUrl: "https://x" });
    expect(c.secretRef).toBe("vault://jira");
    expect(c.enabled).toBe(false);
  });

  it("rejects unknown kind, invalid names and duplicate names within the office", () => {
    const bad = createConnector(
      { officeId, kind: "grpc" as never, name: "x", tools: [] },
      [],
      deps,
    );
    expect(isErr(bad)).toBe(true);
    if (isErr(bad)) expect(bad.error[0]?.path).toBe("kind");
    for (const name of ["", "Git Hub", "git.hub", "-x", "x".repeat(65)]) {
      const r = createConnector({ officeId, kind: "mcp", name, tools: [] }, [], deps);
      expect(isErr(r), JSON.stringify(name)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path).toBe("name");
    }
    const dup = createConnector(
      { officeId, kind: "mcp", name: "github", tools: [] },
      [connector("github", [])],
      deps,
    );
    expect(isErr(dup)).toBe(true);
    if (isErr(dup)) expect(dup.error[0]?.message).toMatch(/already exists/);
  });

  it("rejects duplicate, empty or wildcard tool names and non-object config", () => {
    for (const tools of [["a", "a"], [""], ["*"]]) {
      const r = createConnector({ officeId, kind: "mcp", name: "x", tools }, [], deps);
      expect(isErr(r), JSON.stringify(tools)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path.startsWith("tools")).toBe(true);
    }
    const cfg = createConnector(
      { officeId, kind: "mcp", name: "x", tools: [], config: [] as never },
      [],
      deps,
    );
    expect(isErr(cfg)).toBe(true);
    if (isErr(cfg)) expect(cfg.error[0]?.path).toBe("config");
  });
});

describe("validateToolGrants", () => {
  const github = connector("github", ["get_diff", "create_review"]);

  it("accepts grants for known tools and wildcards", () => {
    expect(
      validateToolGrants(
        [
          { connectorId: github.id, tool: "get_diff" },
          { connectorId: github.id, tool: "*" },
        ],
        [github],
      ),
    ).toEqual([]);
  });

  it("reports unknown connectors and unknown tools with indexed paths", () => {
    const errors = validateToolGrants(
      [
        { connectorId: "ghost", tool: "x" },
        { connectorId: github.id, tool: "delete_repo" },
      ],
      [github],
    );
    expect(errors.map((e) => e.path)).toEqual(["toolGrants[0].connectorId", "toolGrants[1].tool"]);
  });
});

describe("resolveToolAccess and canCallTool", () => {
  const github = connector("github", ["get_diff", "create_review", "merge"]);
  const slack = connector("slack", ["post_message"]);
  const jira = connector("jira", ["create_issue"], { enabled: false });
  const connectors = [github, slack, jira];

  const deptGrants: ToolGrant[] = [{ connectorId: slack.id, tool: "*" }];
  const empGrants: ToolGrant[] = [
    { connectorId: github.id, tool: "get_diff" },
    { connectorId: jira.id, tool: "*" },
  ];
  const ctx = { connectors, departmentGrants: deptGrants, employeeGrants: empGrants };

  it("resolves the union of department and employee grants, expanding wildcards, skipping disabled connectors", () => {
    expect(resolveToolAccess(ctx)).toEqual([
      { connectorId: github.id, tool: "get_diff" },
      { connectorId: slack.id, tool: "post_message" },
    ]);
  });

  it("allows only granted tools on enabled connectors", () => {
    expect(canCallTool(ctx, github.id, "get_diff")).toEqual({ allowed: true });
    expect(canCallTool(ctx, slack.id, "post_message")).toEqual({ allowed: true });
  });

  it("explains every denial", () => {
    expect(canCallTool(ctx, github.id, "merge")).toEqual({ allowed: false, reason: "not_granted" });
    expect(canCallTool(ctx, github.id, "delete_repo")).toEqual({
      allowed: false,
      reason: "unknown_tool",
    });
    expect(canCallTool(ctx, "ghost", "x")).toEqual({
      allowed: false,
      reason: "unknown_connector",
    });
    expect(canCallTool(ctx, jira.id, "create_issue")).toEqual({
      allowed: false,
      reason: "connector_disabled",
    });
  });

  it("department-level grants are inherited by an employee with no grants of their own", () => {
    const inherited = { connectors, departmentGrants: deptGrants, employeeGrants: [] };
    expect(canCallTool(inherited, slack.id, "post_message")).toEqual({ allowed: true });
    expect(canCallTool(inherited, github.id, "get_diff")).toEqual({
      allowed: false,
      reason: "not_granted",
    });
  });

  it("an employee with no grants anywhere can call nothing", () => {
    const none = { connectors, departmentGrants: [], employeeGrants: [] };
    expect(resolveToolAccess(none)).toEqual([]);
    expect(isOk(createConnector({ officeId, kind: "mcp", name: "z", tools: [] }, [], deps))).toBe(
      true,
    );
  });

  it("wildcard on an employee grant covers every tool of that connector", () => {
    const all = {
      connectors,
      departmentGrants: [],
      employeeGrants: [{ connectorId: github.id, tool: "*" }],
    };
    expect(resolveToolAccess(all).map((t) => t.tool)).toEqual([
      "get_diff",
      "create_review",
      "merge",
    ]);
  });
});

describe("tool names a catalogue can tell apart", () => {
  const withTools = (tools: string[]) =>
    createConnector({ officeId, kind: "rest", name: "web", tools }, [], {
      id: () => "conn-1" as ConnectorId,
      now: () => new Date("2026-09-29T09:00:00Z"),
    });

  it("takes an ordinary tool name", () => {
    expect(unwrap(withTools(["fetch_url"])).tools).toEqual(["fetch_url"]);
  });

  it("refuses a name carrying the separator a catalogue uses", () => {
    // Tools are offered to a model as "connector__tool", because a dot is not
    // allowed in a tool name. A tool called "a__b" would be indistinguishable
    // from a tool "b" on a connector "a", and the collision is much cheaper to
    // catch when the office is written than halfway through somebody's turn.
    const refused = withTools(["fetch__url"]);
    if (!isErr(refused)) throw new Error("expected this connector to be refused");
    expect(refused.error[0]?.path).toBe("tools[0]");
  });

  it("says which of several names is the problem", () => {
    const refused = withTools(["fetch_url", "post__thing"]);
    if (!isErr(refused)) throw new Error("expected this connector to be refused");
    expect(refused.error[0]?.path).toBe("tools[1]");
  });
});

describe("how a tool is named on the wire", () => {
  it("joins the connector and the tool", () => {
    expect(toolWireName("web", "fetch_url")).toBe("web__fetch_url");
  });

  it("takes it apart again", () => {
    expect(splitToolWireName("web__fetch_url")).toEqual({ connector: "web", tool: "fetch_url" });
  });

  it("says nothing for a name that was never one of ours", () => {
    expect(splitToolWireName("find_tool")).toBeNull();
  });

  it("splits on the first separator, since only the connector name is guarded", () => {
    expect(splitToolWireName("web__a__b")).toEqual({ connector: "web", tool: "a__b" });
  });
});

describe("a connector that reads the web", () => {
  it("is a kind of its own, so an office says what it means", () => {
    // Not "rest with some configuration": what an office is granting when it
    // grants this is the ability to reach outside, and that deserves a name.
    const made = createConnector(
      {
        officeId,
        kind: "web",
        name: "web",
        tools: ["fetch_url"],
        config: { hosts: ["acme.test"] },
      },
      [],
      { id: () => "conn-web" as ConnectorId, now: () => new Date("2026-09-30T09:00:00Z") },
    );
    expect(unwrap(made).kind).toBe("web");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  MCP_TOOLS_TTL_MS,
  declaredGates,
  mcpBroker,
  mcpTarget,
  type McpConnect,
} from "./mcp-connector.js";
import type { McpCallOutcome, McpSession, McpTool } from "./session.js";

const connectorId = "conn-mcp";

const tool = (name: string, annotations?: McpTool["annotations"]): McpTool => ({
  name,
  description: `the ${name} tool`,
  inputSchema: { type: "object", properties: {} },
  ...(annotations === undefined ? {} : { annotations }),
});

/** A session that answers from a script and counts what it was asked. */
function fakeSession(options: {
  readonly tools?: readonly McpTool[];
  readonly outcome?: McpCallOutcome;
  readonly failList?: Error;
  readonly failCall?: Error;
}) {
  const asked = { lists: 0, calls: [] as { name: string; input: unknown }[], closes: 0 };
  let changed: (() => void) | null = null;
  const session: McpSession = {
    listTools: () => {
      asked.lists += 1;
      if (options.failList) return Promise.reject(options.failList);
      return Promise.resolve(options.tools ?? [tool("read_notes"), tool("send_email")]);
    },
    callTool: (name, input) => {
      asked.calls.push({ name, input });
      if (options.failCall) return Promise.reject(options.failCall);
      return Promise.resolve(options.outcome ?? { text: "done", isError: false });
    },
    onToolsChanged: (handler) => {
      changed = handler;
    },
    protocolVersion: () => "2025-06-18",
    close: () => {
      asked.closes += 1;
      return Promise.resolve();
    },
  };
  return {
    session,
    asked,
    serverChangedItsTools: (): void => {
      changed?.();
    },
  };
}

/** A broker over one scripted session, with a clock a test can move. */
function broker(
  options: {
    readonly config?: Record<string, unknown>;
    readonly tools?: readonly McpTool[];
    readonly outcome?: McpCallOutcome;
    readonly failList?: Error;
    readonly failCall?: Error;
  } = {},
) {
  const fake = fakeSession(options);
  let at = 1_000;
  let connections = 0;
  const connect: McpConnect = () => {
    connections += 1;
    return fake.session;
  };
  return {
    ...fake,
    connections: (): number => connections,
    pass: (ms: number): void => {
      at += ms;
    },
    broker: mcpBroker({
      connectorId,
      name: "acme",
      config: options.config ?? {},
      connect,
      now: () => at,
    }),
  };
}

describe("what an MCP connector says it can do", () => {
  it("offers what the server lists, named as the office will grant it", async () => {
    const described = await broker().broker.describe();

    expect(described.map((one) => one.name)).toEqual(["read_notes", "send_email"]);
    expect(described[0]?.connectorId).toBe(connectorId);
    expect(described[0]?.description).toContain("read_notes");
    expect(described[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("asks the server once and then remembers, because a prompt is built often", async () => {
    const one = broker();

    await one.broker.describe();
    await one.broker.describe();

    expect(one.asked.lists).toBe(1);
  });

  it("asks again when the server says its tools changed", async () => {
    const one = broker();

    await one.broker.describe();
    one.serverChangedItsTools();
    await one.broker.describe();

    expect(one.asked.lists).toBe(2);
  });

  it("asks again once what it remembers is old", async () => {
    const one = broker();

    await one.broker.describe();
    one.pass(MCP_TOOLS_TTL_MS + 1);
    await one.broker.describe();

    expect(one.asked.lists).toBe(2);
  });

  it("offers nothing rather than breaking every other connector, when it cannot be reached", async () => {
    const one = broker({ failList: new Error("connection refused") });

    expect(await one.broker.describe()).toEqual([]);
  });

  it("starts no session until it is asked something", () => {
    expect(broker().connections()).toBe(0);
  });
});

describe("which of a server's tools need a person first", () => {
  const gatesOf = async (config: Record<string, unknown>, tools: readonly McpTool[]) => {
    const described = await broker({ config, tools }).broker.describe();
    return Object.fromEntries(described.map((one) => [one.name, one.gates ?? []]));
  };

  it("treats a tool as acting, until the office says otherwise", async () => {
    expect(await gatesOf({}, [tool("send_email")])).toEqual({ send_email: ["external_send"] });
  });

  it("quiets the one the office listed as harmless", async () => {
    const gates = await gatesOf({ gates: { read_notes: [] } }, [
      tool("read_notes"),
      tool("send_email"),
    ]);

    expect(gates["read_notes"]).toEqual([]);
    expect(gates["send_email"]).toEqual(["external_send"]);
  });

  it("takes the categories the office named for a tool", async () => {
    const gates = await gatesOf({ gates: { pay_invoice: ["spend", "external_send"] } }, [
      tool("pay_invoice"),
    ]);

    expect(gates["pay_invoice"]).toEqual(["spend", "external_send"]);
  });

  it("takes the office's own default for everything unlisted", async () => {
    const gates = await gatesOf({ default: ["deploy"] }, [tool("ship_it")]);

    expect(gates["ship_it"]).toEqual(["deploy"]);
  });

  it("adds what the server admits about itself", async () => {
    const gates = await gatesOf({}, [tool("drop_table", { destructiveHint: true })]);

    expect(gates["drop_table"]).toEqual(["external_send", "delete"]);
  });

  it("lets a server add caution and never remove it", async () => {
    // A server claiming to be read-only is a server's claim. The office decides.
    const gates = await gatesOf({}, [tool("quiet_really", { readOnlyHint: true })]);

    expect(gates["quiet_really"]).toEqual(["external_send"]);
  });

  it("ignores a category the office invented", async () => {
    const gates = await gatesOf({ gates: { odd: ["sideways"] } }, [tool("odd")]);

    expect(gates["odd"]).toEqual([]);
  });

  it("reads a declaration the office wrote for one tool without a list", () => {
    expect(declaredGates({ gates: { send_email: "external_send" } }, tool("send_email"))).toEqual([
      "external_send",
    ]);
  });
});

describe("calling a tool on an MCP server", () => {
  const call = (name: string, input: Record<string, unknown> = {}) => ({ name, input });

  it("calls the tool behind the wire name", async () => {
    const one = broker();

    await one.broker.call(call("acme__send_email", { to: "ada@acme.test" }));

    expect(one.asked.calls).toEqual([{ name: "send_email", input: { to: "ada@acme.test" } }]);
  });

  it("tells the model what the tool said", async () => {
    const one = broker({ outcome: { text: "sent to ada@acme.test", isError: false } });

    const outcome = await one.broker.call(call("acme__send_email"));

    expect(outcome.summary).toContain("sent to ada@acme.test");
    expect(outcome.artifact).toBeUndefined();
  });

  it("files a long answer as a document and tells the model the opening of it", async () => {
    const long = "x".repeat(5_000);
    const one = broker({ outcome: { text: long, isError: false } });

    const outcome = await one.broker.call(call("acme__read_notes"));

    expect(outcome.summary.length).toBeLessThan(long.length);
    expect(outcome.artifact?.content).toBe(long);
    expect(outcome.artifact?.name).toBe("acme-read_notes.md");
  });

  it("says when the tool itself reported a failure, which the model can act on", async () => {
    const one = broker({ outcome: { text: "no such mailbox", isError: false } });
    const failing = broker({ outcome: { text: "no such mailbox", isError: true } });

    expect((await one.broker.call(call("acme__send_email"))).summary).not.toMatch(
      /refused|failed/i,
    );
    expect((await failing.broker.call(call("acme__send_email"))).summary).toMatch(
      /no such mailbox/,
    );
    expect((await failing.broker.call(call("acme__send_email"))).summary).toMatch(/fail/i);
  });

  it("refuses a name that is not one of this connector's tools", async () => {
    await expect(broker().broker.call(call("acme__nothing_like_it"))).rejects.toThrow(
      /nothing_like_it/,
    );
  });
});

describe("a server that goes away mid-shift", () => {
  it("opens a new session and makes the call anyway", async () => {
    // The transport does not reconnect itself: a fresh process has not been
    // introduced to. So the broker drops the session and opens another.
    let attempt = 0;
    const sessions: McpSession[] = [];
    const connect: McpConnect = () => {
      attempt += 1;
      const failing = attempt === 1;
      const session: McpSession = {
        listTools: () => Promise.resolve([tool("send_email")]),
        callTool: () =>
          failing
            ? Promise.reject(new Error("node closed (exit 1)"))
            : Promise.resolve({ text: "sent", isError: false }),
        onToolsChanged: () => undefined,
        protocolVersion: () => "2025-06-18",
        close: () => Promise.resolve(),
      };
      sessions.push(session);
      return session;
    };
    const one = mcpBroker({ connectorId, name: "acme", config: {}, connect });

    const outcome = await one.call({ name: "acme__send_email", input: {} });

    expect(outcome.summary).toContain("sent");
    expect(sessions).toHaveLength(2);
  });

  it("says so in a sentence rather than failing the whole turn", async () => {
    const one = broker({ failCall: new Error("node closed (exit 1)") });

    const outcome = await one.broker.call({ name: "acme__send_email", input: {} });

    expect(outcome.summary).toMatch(/could not/i);
    expect(outcome.summary).toContain("exit 1");
  });

  it("tries once more and no further, so a turn cannot spin on a dead server", async () => {
    const one = broker({ failCall: new Error("node closed (exit 1)") });

    await one.broker.call({ name: "acme__send_email", input: {} });

    expect(one.asked.calls).toHaveLength(2);
  });
});

describe("where the server is, out of a configuration that is untyped", () => {
  it("reads a command to run", () => {
    expect(mcpTarget({ command: "npx", args: ["-y", "acme-mcp"] }, {})).toEqual({
      kind: "stdio",
      command: "npx",
      args: ["-y", "acme-mcp"],
      env: {},
    });
  });

  it("passes on only the variables the office named, by name", () => {
    const target = mcpTarget(
      { command: "acme-mcp", env: ["ACME_HOME", "NOT_SET"] },
      {
        ACME_HOME: "/srv/acme",
        SECRET_ELSEWHERE: "no",
      },
    );

    expect(target).toMatchObject({ env: { ACME_HOME: "/srv/acme" } });
  });

  it("reads an address to post to, and the credential named beside it", () => {
    expect(
      mcpTarget(
        { url: "https://mcp.acme.test", tokenEnv: "ACME_MCP_TOKEN" },
        {
          ACME_MCP_TOKEN: "sk-mcp",
        },
      ),
    ).toEqual({ kind: "http", url: "https://mcp.acme.test", token: "sk-mcp" });
  });

  it("says which variable is missing, rather than posting with no credential", () => {
    const target = mcpTarget({ url: "https://mcp.acme.test", tokenEnv: "ACME_MCP_TOKEN" }, {});

    expect(target).toMatchObject({ kind: "none" });
    expect(target.kind === "none" && target.reason).toContain("ACME_MCP_TOKEN");
  });

  it("refuses an address that is not https, since a token would travel in the open", () => {
    expect(mcpTarget({ url: "http://mcp.acme.test" }, {}).kind).toBe("none");
  });

  it("allows a local address over plain http, which is where a server is tried out", () => {
    expect(mcpTarget({ url: "http://127.0.0.1:3200/mcp" }, {}).kind).toBe("http");
    expect(mcpTarget({ url: "http://localhost:3200/mcp" }, {}).kind).toBe("http");
  });

  it("says so when the office has configured nothing at all", () => {
    expect(mcpTarget({}, {}).kind).toBe("none");
  });

  it("reaches nothing, in a sentence, when it does not know where to go", async () => {
    const unconfigured = mcpBroker({ connectorId, name: "acme", config: {} });

    expect(await unconfigured.describe()).toEqual([]);
    const outcome = await unconfigured.call({ name: "acme__anything", input: {} });
    expect(outcome.summary).toMatch(/not configured|nothing to reach|no server/i);
  });
});

describe("closing up", () => {
  it("closes the session it opened", async () => {
    const one = broker();
    await one.broker.describe();

    await one.broker.close();

    expect(one.asked.closes).toBe(1);
  });

  it("has nothing to close when it never opened one", async () => {
    const one = broker();

    await one.broker.close();

    expect(one.asked.closes).toBe(0);
  });
});

describe("the gates a web connector declares", () => {
  it("declares none, and says so rather than leaving it to a default", async () => {
    // Asserted here beside the MCP gates so the two kinds are read together:
    // reading a page the office named is not one of the categories a gate holds.
    const { webBroker } = await import("../web/web-connector.js");
    const described = await webBroker({
      connectorId: "conn-web",
      name: "web",
      config: { hosts: ["acme.test"] },
      fetch: () => Promise.reject(new Error("not called")),
    }).describe();

    expect(described[0]?.gates).toEqual([]);
  });
});

describe("a connector kind the office understands", () => {
  it("is offered by the office broker, so an MCP tool reaches the model", async () => {
    const { officeBroker } = await import("../office-broker.js");
    const connector = {
      id: connectorId,
      officeId: "office-1",
      kind: "mcp" as const,
      name: "acme",
      config: { command: "echo" },
      secretRef: null,
      tools: ["send_email"],
      enabled: true,
      createdAt: new Date("2026-10-03T09:00:00Z"),
    };
    const listed = vi.fn(() => Promise.resolve([tool("send_email")]));
    const office = officeBroker([connector as never], {
      connect: () => ({
        listTools: listed,
        callTool: () => Promise.resolve({ text: "sent", isError: false }),
        onToolsChanged: () => undefined,
        protocolVersion: () => "2025-06-18",
        close: () => Promise.resolve(),
      }),
    });

    const described = await office.describe();

    expect(described.map((one) => one.name)).toEqual(["send_email"]);
    expect(listed).toHaveBeenCalled();
  });
});

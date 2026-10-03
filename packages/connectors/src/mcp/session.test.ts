import { describe, expect, it, vi } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  McpProtocolError,
  mcpSession,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransport,
} from "./session.js";

/**
 * A transport that answers from a table of methods and records what it was
 * asked, so every test of the protocol is a test of what went over the wire.
 */
function scripted(answers: Record<string, readonly Record<string, unknown>[]>) {
  const sent: JsonRpcRequest[] = [];
  const told: JsonRpcNotification[] = [];
  let deliver: ((notification: JsonRpcNotification) => void) | null = null;
  let closed = 0;
  const pending = new Map(Object.entries(answers).map(([method, list]) => [method, [...list]]));

  const transport: McpTransport = {
    request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
      sent.push(message);
      const queue = pending.get(message.method);
      const next = queue?.shift();
      if (next === undefined) {
        return Promise.resolve({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `nothing scripted for ${message.method}` },
        });
      }
      return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: next });
    },
    notify(message: JsonRpcNotification): Promise<void> {
      told.push(message);
      return Promise.resolve();
    },
    onNotification(handler) {
      deliver = handler;
    },
    close(): Promise<void> {
      closed += 1;
      return Promise.resolve();
    },
  };

  return {
    transport,
    sent,
    told,
    methods: (): string[] => sent.map((message) => message.method),
    closes: (): number => closed,
    fromServer: (notification: JsonRpcNotification): void => {
      deliver?.(notification);
    },
  };
}

const initialized = (version = MCP_PROTOCOL_VERSION): Record<string, unknown> => ({
  protocolVersion: version,
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "acme-mcp", version: "1.0.0" },
});

const oneTool = {
  tools: [
    {
      name: "send_email",
      description: "Send an email.",
      inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    },
  ],
};

describe("opening a session with an MCP server", () => {
  it("introduces itself before it asks for anything", async () => {
    const wire = scripted({ initialize: [initialized()], "tools/list": [oneTool] });
    const session = mcpSession({ transport: wire.transport, clientName: "virtual-office" });

    await session.listTools();

    expect(wire.methods()).toEqual(["initialize", "tools/list"]);
    const hello = wire.sent[0];
    expect(hello?.params?.["protocolVersion"]).toBe(MCP_PROTOCOL_VERSION);
    expect(hello?.params?.["clientInfo"]).toMatchObject({ name: "virtual-office" });
    // The handshake is not finished until the server has been told it is: a
    // server may hold everything else until this arrives.
    expect(wire.told.map((one) => one.method)).toEqual(["notifications/initialized"]);
  });

  it("introduces itself once, however much it then asks", async () => {
    const wire = scripted({
      initialize: [initialized()],
      "tools/list": [oneTool, oneTool],
    });
    const session = mcpSession({ transport: wire.transport });

    await session.listTools();
    await session.listTools();

    expect(wire.methods()).toEqual(["initialize", "tools/list", "tools/list"]);
  });

  it("takes the version the server answers with, which is what the spec says to do", async () => {
    const wire = scripted({ initialize: [initialized("2025-03-26")], "tools/list": [oneTool] });
    const session = mcpSession({ transport: wire.transport });

    await session.listTools();

    expect(session.protocolVersion()).toBe("2025-03-26");
  });

  it("will not talk to a server whose version it does not know", async () => {
    const wire = scripted({ initialize: [initialized("1999-01-01")] });
    const session = mcpSession({ transport: wire.transport });

    await expect(session.listTools()).rejects.toThrow(/1999-01-01/);
    // Nothing was asked of a server this client cannot understand.
    expect(wire.methods()).toEqual(["initialize"]);
  });
});

describe("what the server says it can do", () => {
  it("lists its tools", async () => {
    const wire = scripted({ initialize: [initialized()], "tools/list": [oneTool] });

    const tools = await mcpSession({ transport: wire.transport }).listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("send_email");
    expect(tools[0]?.description).toBe("Send an email.");
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" });
  });

  it("follows the cursor, so a long list arrives whole", async () => {
    const wire = scripted({
      initialize: [initialized()],
      "tools/list": [
        { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" },
        { tools: [{ name: "second", inputSchema: { type: "object" } }] },
      ],
    });

    const tools = await mcpSession({ transport: wire.transport }).listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["first", "second"]);
    expect(wire.sent.at(-1)?.params?.["cursor"]).toBe("page-2");
  });

  it("stops following a cursor that never changes, rather than paging forever", async () => {
    const stuck = {
      tools: [{ name: "first", inputSchema: { type: "object" } }],
      nextCursor: "same",
    };
    const wire = scripted({
      initialize: [initialized()],
      "tools/list": Array.from({ length: 40 }, () => stuck),
    });

    const tools = await mcpSession({ transport: wire.transport }).listTools();

    expect(tools.length).toBeGreaterThan(0);
    expect(wire.methods().filter((method) => method === "tools/list").length).toBeLessThan(40);
  });

  it("keeps the hints a tool declares about itself", async () => {
    const wire = scripted({
      initialize: [initialized()],
      "tools/list": [
        {
          tools: [
            {
              name: "drop_table",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false, destructiveHint: true },
            },
          ],
        },
      ],
    });

    const tools = await mcpSession({ transport: wire.transport }).listTools();

    expect(tools[0]?.annotations).toMatchObject({ destructiveHint: true });
  });

  it("ignores a tool with no name, which there is nothing to call", async () => {
    const wire = scripted({
      initialize: [initialized()],
      "tools/list": [{ tools: [{ inputSchema: { type: "object" } }, { name: "real" }] }],
    });

    const tools = await mcpSession({ transport: wire.transport }).listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["real"]);
  });

  it("says when the server was asked something it refused", async () => {
    const wire = scripted({ initialize: [initialized()] });

    await expect(mcpSession({ transport: wire.transport }).listTools()).rejects.toBeInstanceOf(
      McpProtocolError,
    );
  });
});

describe("calling a tool", () => {
  const callingSession = (results: readonly Record<string, unknown>[]) => {
    const wire = scripted({ initialize: [initialized()], "tools/call": results });
    return { wire, session: mcpSession({ transport: wire.transport }) };
  };

  it("sends the name and the arguments, as the protocol names them", async () => {
    const { wire, session } = callingSession([{ content: [{ type: "text", text: "Sent." }] }]);

    await session.callTool("send_email", { to: "ada@acme.test" });

    const call = wire.sent.at(-1);
    expect(call?.method).toBe("tools/call");
    expect(call?.params).toMatchObject({
      name: "send_email",
      arguments: { to: "ada@acme.test" },
    });
  });

  it("reads back the text of what came out", async () => {
    const { session } = callingSession([
      {
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      },
    ]);

    const outcome = await session.callTool("send_email", {});

    expect(outcome.text).toBe("line one\nline two");
    expect(outcome.isError).toBe(false);
  });

  it("leaves out what it cannot read, rather than describing it", async () => {
    const { session } = callingSession([
      {
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: "and a caption" },
        ],
      },
    ]);

    expect((await session.callTool("render", {})).text).toBe("and a caption");
  });

  it("carries the server's own failure through as one", async () => {
    const { session } = callingSession([
      { content: [{ type: "text", text: "no such mailbox" }], isError: true },
    ]);

    const outcome = await session.callTool("send_email", {});

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("no such mailbox");
  });

  it("does not pretend a tool that answered nothing said something", async () => {
    const { session } = callingSession([{ content: [] }]);

    expect((await session.callTool("send_email", {})).text).toBe("");
  });
});

describe("a server that changes its mind", () => {
  it("passes on that its tool list changed", async () => {
    const wire = scripted({ initialize: [initialized()], "tools/list": [oneTool] });
    const session = mcpSession({ transport: wire.transport });
    const changed = vi.fn();
    session.onToolsChanged(changed);

    await session.listTools();
    wire.fromServer({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("is not disturbed by a notification it has no interest in", async () => {
    const wire = scripted({ initialize: [initialized()], "tools/list": [oneTool] });
    const session = mcpSession({ transport: wire.transport });
    const changed = vi.fn();
    session.onToolsChanged(changed);

    await session.listTools();
    wire.fromServer({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });

    expect(changed).not.toHaveBeenCalled();
  });

  it("closes the transport when it is closed", async () => {
    const wire = scripted({ initialize: [initialized()], "tools/list": [oneTool] });
    const session = mcpSession({ transport: wire.transport });

    await session.listTools();
    await session.close();

    expect(wire.closes()).toBe(1);
  });
});

/**
 * The two transports, against a real MCP server.
 *
 * The server here is the official SDK's, which is this package's devDependency
 * and reaches no deploy image. That is the point: these tests prove that what
 * this office's hand-written client puts on the wire is MCP, rather than
 * proving that one library agrees with itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { notesServer } from "./fixtures/notes-server.mjs";
import { mcpSession, type McpSession } from "./session.js";
import { stdioTransport } from "./stdio.js";
import { httpTransport } from "./http.js";

const FIXTURE = new URL("./fixtures/notes-stdio.mjs", import.meta.url).pathname;

const open: McpSession[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function overStdio(args: readonly string[] = [FIXTURE]): McpSession {
  const session = mcpSession({
    transport: stdioTransport({ command: process.execPath, args }),
  });
  open.push(session);
  return session;
}

/** The fixture mounted on a real HTTP server, with every request's headers kept. */
async function overHttp(options: { readonly token?: string } = {}): Promise<{
  readonly session: McpSession;
  readonly headers: IncomingHttpHeaders[];
}> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
  await notesServer().connect(transport);

  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    headers.push(request.headers);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      void transport.handleRequest(
        request,
        response,
        raw.length === 0 ? undefined : (JSON.parse(raw) as unknown),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  const session = mcpSession({
    transport: httpTransport({
      url: `http://127.0.0.1:${String(port)}/mcp`,
      ...(options.token === undefined ? {} : { token: options.token }),
    }),
  });
  open.push(session);
  return { session, headers };
}

describe("talking to an MCP server over stdio", () => {
  it("lists what it offers", async () => {
    const tools = await overStdio().listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "drop_table",
      "read_notes",
      "send_email",
    ]);
    expect(tools.find((tool) => tool.name === "read_notes")?.description).toMatch(/notes/i);
  });

  it("brings back the hints the server declares, which the gate reads later", async () => {
    const tools = await overStdio().listTools();

    expect(tools.find((tool) => tool.name === "read_notes")?.annotations).toMatchObject({
      readOnlyHint: true,
    });
    expect(tools.find((tool) => tool.name === "drop_table")?.annotations).toMatchObject({
      destructiveHint: true,
    });
  });

  it("calls a tool and reads the answer", async () => {
    const outcome = await overStdio().callTool("read_notes", { topic: "pricing" });

    expect(outcome.text).toBe("notes about pricing");
    expect(outcome.isError).toBe(false);
  });

  it("carries a tool's own failure back as one", async () => {
    const outcome = await overStdio().callTool("drop_table", {});

    expect(outcome.isError).toBe(true);
  });

  it("says so when the command is not a server at all", async () => {
    await expect(overStdio(["-e", "process.exit(3)"]).listTools()).rejects.toThrow(/exit|clos/i);
  });

  it("says so when the command cannot be run", async () => {
    const session = mcpSession({
      transport: stdioTransport({ command: "/definitely/not/a/program", args: [] }),
    });
    open.push(session);

    await expect(session.listTools()).rejects.toThrow();
  });
});

describe("talking to an MCP server over HTTP", () => {
  it("lists what it offers", async () => {
    const { session } = await overHttp();

    const tools = await session.listTools();

    expect(tools.map((tool) => tool.name)).toContain("send_email");
  });

  it("calls a tool and reads the answer", async () => {
    const { session } = await overHttp();

    const outcome = await session.callTool("send_email", { to: "ada@acme.test" });

    expect(outcome.text).toBe("sent to ada@acme.test");
  });

  it("keeps the session the server gave it, or every later call is a stranger", async () => {
    const { session, headers } = await overHttp();

    await session.listTools();

    const seen = headers.map((one) => one["mcp-session-id"]);
    expect(seen[0]).toBeUndefined();
    expect(seen.at(-1)).toMatch(/[0-9a-f-]{36}/);
  });

  it("says which protocol version it settled on, as the spec requires", async () => {
    const { session, headers } = await overHttp();

    await session.listTools();

    expect(headers.at(-1)?.["mcp-protocol-version"]).toBe(session.protocolVersion());
  });

  it("carries the credential the office named, and never anything else", async () => {
    const { session, headers } = await overHttp({ token: "sk-mcp" });

    await session.listTools();

    expect(headers.at(-1)?.authorization).toBe("Bearer sk-mcp");
  });

  it("offers no credential when the office configured none", async () => {
    const { session, headers } = await overHttp();

    await session.listTools();

    expect(headers.at(-1)?.authorization).toBeUndefined();
  });

  it("says so when there is nothing listening", async () => {
    const session = mcpSession({
      transport: httpTransport({ url: "http://127.0.0.1:1/mcp" }),
    });
    open.push(session);

    await expect(session.listTools()).rejects.toThrow();
  });
});

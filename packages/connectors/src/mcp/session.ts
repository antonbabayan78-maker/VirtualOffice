/**
 * Speaking MCP: one session with one server.
 *
 * Deliberately the protocol and nothing else — a handshake, `tools/list`,
 * `tools/call`, and the one notification that matters. No caching, no
 * reconnecting, no opinion about what a tool is allowed to do; those belong to
 * the broker above, which is why they are testable here without a socket and
 * there without a server.
 *
 * Hand-written rather than the official SDK, which is a devDependency of this
 * package and runs the real server in the tests. The client half this office
 * needs is three methods; the SDK's half brings express, hono, ajv and jose
 * into both deploy images to provide them. Testing our client against the SDK's
 * server is a stronger guarantee than using the SDK on both sides, because the
 * test then proves the wire rather than one library agreeing with itself.
 */

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcFailure {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: number | string; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: number | string; readonly error: JsonRpcFailure };

/**
 * The seam under the session: something that carries one request and brings
 * back its answer. A request/response port rather than a message stream,
 * because that is the shape both transports actually have — stdio correlates
 * ids itself, and streamable HTTP answers each POST.
 */
export interface McpTransport {
  request(message: JsonRpcRequest): Promise<JsonRpcResponse>;
  notify(message: JsonRpcNotification): Promise<void>;
  /** Server-initiated notifications, for a transport that can carry them. */
  onNotification?: (handler: (notification: JsonRpcNotification) => void) => void;
  close(): Promise<void>;
}

/** What this client asks for. A server may answer with any version it prefers. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * The versions this client knows how to talk. `tools/list` and `tools/call` are
 * the same in all of them, which is why the list can be this generous — and why
 * a version outside it is refused rather than guessed at.
 */
export const KNOWN_PROTOCOL_VERSIONS: readonly string[] = [
  "2025-11-25",
  MCP_PROTOCOL_VERSION,
  "2025-03-26",
  "2024-11-05",
];

/** Pages of `tools/list` to follow before deciding a server is paging in circles. */
export const MAX_TOOL_PAGES = 20;

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "McpProtocolError";
  }
}

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  /** What the server says about its own tool. A hint, never a permission. */
  readonly annotations?: McpToolAnnotations;
}

export interface McpCallOutcome {
  /** The text blocks of the result, joined. Everything else is left out. */
  readonly text: string;
  /** The server's own verdict on its call, not a transport failure. */
  readonly isError: boolean;
}

export interface McpSession {
  listTools(): Promise<readonly McpTool[]>;
  callTool(name: string, input: Record<string, unknown>): Promise<McpCallOutcome>;
  /** Called when the server says its tools changed. */
  onToolsChanged(handler: () => void): void;
  /** What was agreed at the handshake, or null before it has happened. */
  protocolVersion(): string | null;
  close(): Promise<void>;
}

export interface McpSessionOptions {
  readonly transport: McpTransport;
  /** How this office introduces itself, which a server may log or display. */
  readonly clientName?: string;
}

const CLIENT_VERSION = "0.0.1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The hints a server declares, keeping only the ones that are actually booleans. */
function annotationsOf(raw: unknown): McpToolAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;
  const kept: McpToolAnnotations = {};
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "boolean") (kept as Record<string, boolean>)[key] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
}

/** One entry of `tools/list`, or null for an entry there is nothing to call. */
function toolFrom(raw: unknown): McpTool | null {
  if (!isRecord(raw)) return null;
  const name = text(raw["name"]);
  if (name === undefined) return null;
  const description = text(raw["description"]);
  const schema = raw["inputSchema"];
  const annotations = annotationsOf(raw["annotations"]);
  return {
    name,
    inputSchema: isRecord(schema) ? schema : { type: "object", properties: {} },
    ...(description === undefined ? {} : { description }),
    ...(annotations === undefined ? {} : { annotations }),
  };
}

export function mcpSession(options: McpSessionOptions): McpSession {
  const transport = options.transport;
  let nextId = 1;
  let agreed: string | null = null;
  let handshake: Promise<void> | null = null;
  const toolsChanged: (() => void)[] = [];

  transport.onNotification?.((notification) => {
    if (notification.method !== "notifications/tools/list_changed") return;
    for (const handler of toolsChanged) handler();
  });

  const ask = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const response = await transport.request({
      jsonrpc: "2.0",
      id: nextId++,
      method,
      ...(params === undefined ? {} : { params }),
    });
    if ("error" in response) {
      throw new McpProtocolError(
        response.error.code,
        `the server refused ${method}: ${response.error.message}`,
      );
    }
    return response.result;
  };

  /** The handshake, which happens once however many calls follow it. */
  const ready = (): Promise<void> => {
    handshake ??= (async () => {
      const result = await ask("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: options.clientName ?? "virtual-office", version: CLIENT_VERSION },
      });
      const version = isRecord(result) ? text(result["protocolVersion"]) : undefined;
      // A version nothing here understands is refused rather than worked
      // around: the alternative is a session that looks open and answers
      // nothing a prompt can use.
      if (version !== undefined && !KNOWN_PROTOCOL_VERSIONS.includes(version)) {
        throw new McpProtocolError(
          -32602,
          `this office does not speak MCP ${version}; it knows ${KNOWN_PROTOCOL_VERSIONS.join(", ")}`,
        );
      }
      agreed = version ?? MCP_PROTOCOL_VERSION;
      // Until this arrives a server is entitled to answer nothing else.
      await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
    })();
    return handshake;
  };

  return {
    protocolVersion: () => agreed,

    async listTools(): Promise<readonly McpTool[]> {
      await ready();
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
        const result = await ask("tools/list", cursor === undefined ? {} : { cursor });
        const listed = isRecord(result) ? result["tools"] : [];
        for (const raw of Array.isArray(listed) ? listed : []) {
          const tool = toolFrom(raw);
          if (tool !== null) tools.push(tool);
        }
        const next = isRecord(result) ? text(result["nextCursor"]) : undefined;
        // A cursor that has not moved is a server paging in circles, and
        // following it is a worker that never comes back.
        if (next === undefined || next === cursor) return tools;
        cursor = next;
      }
      return tools;
    },

    async callTool(name: string, input: Record<string, unknown>): Promise<McpCallOutcome> {
      await ready();
      const result = await ask("tools/call", { name, arguments: input });
      const content = isRecord(result) ? result["content"] : [];
      const blocks = Array.isArray(content) ? content : [];
      const said = blocks
        .map((block) =>
          isRecord(block) && block["type"] === "text" ? text(block["text"]) : undefined,
        )
        .filter((line): line is string => line !== undefined);
      return {
        text: said.join("\n"),
        isError: isRecord(result) && result["isError"] === true,
      };
    },

    onToolsChanged(handler: () => void): void {
      toolsChanged.push(handler);
    },

    close(): Promise<void> {
      return transport.close();
    },
  };
}

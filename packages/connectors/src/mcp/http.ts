/**
 * An MCP server over HTTP: one POST per request.
 *
 * Streamable HTTP, which is the transport that replaced plain SSE. A request is
 * a POST of one JSON-RPC message; the answer comes back either as JSON or as a
 * one-event stream, and both are accepted because a server picks. Two headers
 * are the transport's own business and are kept here rather than in the
 * session: the session id a server hands out at the handshake, without which
 * every later call arrives as a stranger, and the agreed protocol version,
 * which the spec requires on every request after the handshake.
 *
 * What is deliberately missing is the server-to-client GET stream. It is
 * optional in the protocol, and the only thing this office would hear on it is
 * `tools/list_changed` — which the broker also covers with a short cache, so
 * the cost of leaving it out is a stale tool list for a minute rather than a
 * capability nobody has.
 *
 * `fetch` is injected, as everywhere else in this package, so a test can answer
 * without a socket.
 */
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpTransport,
} from "./session.js";

export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly url: string;
  /** The bearer this server wants, already read from wherever it was named. */
  readonly token?: string;
  readonly fetch?: HttpFetch;
  readonly timeoutMs?: number;
}

export const MCP_HTTP_TIMEOUT_MS = 30_000;

const SESSION_HEADER = "mcp-session-id";
const VERSION_HEADER = "mcp-protocol-version";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first JSON-RPC message in an event stream.
 *
 * A server answering one request sends one; anything after it belongs to a
 * stream this transport does not keep open, so it is not waited for.
 */
export function firstMessageOf(body: string): unknown {
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) continue;
    try {
      return JSON.parse(payload);
    } catch {
      // A data line that is not JSON is not an answer; keep reading.
      continue;
    }
  }
  return undefined;
}

export function httpTransport(options: HttpOptions): McpTransport {
  const doFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const timeout = options.timeoutMs ?? MCP_HTTP_TIMEOUT_MS;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;

  const headersFor = (): Record<string, string> => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(sessionId === null ? {} : { [SESSION_HEADER]: sessionId }),
    ...(protocolVersion === null ? {} : { [VERSION_HEADER]: protocolVersion }),
  });

  const post = async (message: JsonRpcRequest | JsonRpcNotification): Promise<Response> => {
    const response = await doFetch(options.url, {
      method: "POST",
      headers: headersFor(),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeout),
    });
    const handed = response.headers.get(SESSION_HEADER);
    if (handed !== null && handed.length > 0) sessionId = handed;
    return response;
  };

  return {
    async request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
      const response = await post(message);
      if (!response.ok) {
        throw new Error(`${options.url} answered ${String(response.status)} to ${message.method}`);
      }

      const type = response.headers.get("content-type") ?? "";
      const body = await response.text();
      const parsed: unknown = type.includes("text/event-stream")
        ? firstMessageOf(body)
        : body.length === 0
          ? undefined
          : JSON.parse(body);

      if (!isRecord(parsed)) {
        throw new Error(`${options.url} answered nothing usable to ${message.method}`);
      }
      // Taken from the handshake's own answer, because every request after it
      // has to carry the version that was agreed.
      if (message.method === "initialize" && isRecord(parsed["result"])) {
        const agreed = parsed["result"]["protocolVersion"];
        if (typeof agreed === "string") protocolVersion = agreed;
      }
      return parsed as unknown as JsonRpcResponse;
    },

    async notify(message: JsonRpcNotification): Promise<void> {
      const response = await post(message);
      // 202 is the protocol's answer to a notification; a body, if any, is not
      // an answer to anything and is dropped.
      if (!response.ok) {
        throw new Error(`${options.url} answered ${String(response.status)} to ${message.method}`);
      }
    },

    close(): Promise<void> {
      // Nothing is held open. A server that tracks sessions may be told, but a
      // DELETE it never implemented must not look like a failure to close.
      if (sessionId === null) return Promise.resolve();
      const id = sessionId;
      sessionId = null;
      return doFetch(options.url, {
        method: "DELETE",
        headers: {
          [SESSION_HEADER]: id,
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
          ...(protocolVersion === null ? {} : { [VERSION_HEADER]: protocolVersion }),
        },
        signal: AbortSignal.timeout(timeout),
      }).then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

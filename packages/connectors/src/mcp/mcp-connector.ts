/**
 * An MCP server as one of the office's connectors.
 *
 * A second broker rather than a special case: `describe` is `tools/list` and
 * `call` is `tools/call`, which is the whole of it. Everything that makes it
 * usable sits here rather than in the session — the tool list is remembered
 * because a prompt is built far more often than a server changes, a dropped
 * server is reconnected once, and a failure comes back as a sentence the model
 * can act on rather than as a turn that fell over.
 *
 * **What needs a person.** A tool here is treated as acting until the office
 * says otherwise. That is the safe default and the noisy one: an office that
 * grants a search tool will be asked about every search until it writes
 * `gates: { search_issues: [] }` on the connector. The alternative default —
 * gate only what somebody remembered to name — means the first tool anybody
 * adds can send mail with nobody asked, which is the failure this whole gate
 * exists to prevent. A server's own annotations are read, but they may only add
 * caution: `destructiveHint` adds `delete`, while `readOnlyHint` removes
 * nothing, because it is the server's claim about itself and the office is what
 * decides.
 *
 * **The grant model still bounds all of it.** A server that starts reporting a
 * new tool cannot introduce it: `catalogFor` intersects what is described with
 * what the office granted, and a grant names a tool the office wrote down.
 */
import { GATED_ACTIONS, isGatedAction, type GatedAction } from "@vo/core";
import type {
  BrokerArtifact,
  BrokerCall,
  BrokerOutcome,
  DescribedTool,
  ToolBroker,
} from "@vo/orchestrator";
import { httpTransport, type HttpFetch } from "./http.js";
import { mcpSession, type McpSession, type McpTool } from "./session.js";
import { stdioTransport } from "./stdio.js";

/** How long a remembered tool list is trusted when no server says otherwise. */
export const MCP_TOOLS_TTL_MS = 60_000;

/** What the model is told of a long answer; the rest is filed. */
export const MCP_EXCERPT_CHARS = 2_000;

/** The category a tool falls into when nobody has said which. */
export const DEFAULT_MCP_GATES: readonly GatedAction[] = ["external_send"];

export type McpConnect = () => McpSession;

export interface McpConnectorOptions {
  readonly connectorId: string;
  /** The connector's name, which is the prefix on its tool names. */
  readonly name: string;
  readonly config: Readonly<Record<string, unknown>>;
  /** Builds a session. Injected by tests; derived from the config otherwise. */
  readonly connect?: McpConnect;
  /** Where a named credential is read from. The office never holds the value. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: HttpFetch;
  readonly now?: () => number;
  /**
   * Told why this connector is offering nothing. `describe` stays forgiving —
   * one unreachable server must not empty the catalogue of the others — but
   * silence is how a broken connector goes unnoticed, so the reason goes to
   * whoever asked: a worker's log, or the answer to somebody pressing Discover.
   */
  readonly onProblem?: (message: string) => void;
}

export type McpTarget =
  | {
      readonly kind: "stdio";
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
    }
  | { readonly kind: "http"; readonly url: string; readonly token?: string }
  | { readonly kind: "none"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

/**
 * A local address may be plain http; anything else may not.
 *
 * The same reasoning as the session cookie's `Secure` flag: a token on the open
 * wire is a token in somebody's proxy log, and the only place plain http is
 * genuinely fine is the machine the office is already running on — which is
 * exactly where somebody tries a server out.
 */
function isLocal(url: URL): boolean {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

/** Where this connector's server is, read out of a configuration that is untyped. */
export function mcpTarget(
  config: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string | undefined>>,
): McpTarget {
  const command = config["command"];
  if (typeof command === "string" && command.length > 0) {
    const named = strings(config["env"]);
    const passed: Record<string, string> = {};
    for (const name of named) {
      const value = env[name];
      if (value !== undefined) passed[name] = value;
    }
    return { kind: "stdio", command, args: strings(config["args"]), env: passed };
  }

  const url = config["url"];
  if (typeof url === "string" && url.length > 0) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { kind: "none", reason: `"${url}" is not an address` };
    }
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal(parsed))) {
      return {
        kind: "none",
        reason: `${url} is not https, and only a local server may be reached in the open`,
      };
    }
    const tokenEnv = config["tokenEnv"];
    if (typeof tokenEnv === "string" && tokenEnv.length > 0) {
      const token = env[tokenEnv];
      if (token === undefined || token.length === 0) {
        return {
          kind: "none",
          reason: `${tokenEnv} is not set here, so there is no credential for ${url}`,
        };
      }
      return { kind: "http", url, token };
    }
    return { kind: "http", url };
  }

  return {
    kind: "none",
    reason: "this connector names no server: it needs a command to run or a url to post to",
  };
}

/** The categories the office declared for one tool, plus what the server admits. */
export function declaredGates(
  config: Readonly<Record<string, unknown>>,
  tool: McpTool,
): readonly GatedAction[] {
  const declared = isRecord(config["gates"]) ? config["gates"] : {};
  const forTool = Object.prototype.hasOwnProperty.call(declared, tool.name)
    ? declared[tool.name]
    : undefined;
  const fallback = Object.prototype.hasOwnProperty.call(config, "default")
    ? config["default"]
    : DEFAULT_MCP_GATES;

  // A single category is as valid a declaration as a list of one.
  const raw = forTool === undefined ? fallback : forTool;
  const asked = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];

  const gates: GatedAction[] = [];
  for (const action of asked) {
    if (isGatedAction(action) && !gates.includes(action)) gates.push(action);
  }
  // Only ever added: a server saying it is harmless is not the office saying so.
  if (tool.annotations?.destructiveHint === true && !gates.includes("delete")) gates.push("delete");
  return gates;
}

const said = (summary: string): BrokerOutcome => ({ summary });

/** What came back, as something to say now and something to keep if it is long. */
function outcomeOf(
  connectorName: string,
  tool: string,
  text: string,
  isError: boolean,
): BrokerOutcome {
  const opening = text.slice(0, MCP_EXCERPT_CHARS);
  const whole = text.length > MCP_EXCERPT_CHARS;
  const summary = isError
    ? `${tool} failed: ${opening}`
    : whole
      ? `${tool} answered (${String(text.length)} characters). It begins:\n${opening}`
      : opening;
  if (!whole) return said(summary);
  const artifact: BrokerArtifact = {
    name: `${connectorName}-${tool}.md`,
    mediaType: "text/markdown",
    content: text,
  };
  return { summary, artifact };
}

export function mcpBroker(options: McpConnectorOptions): ToolBroker & {
  close(): Promise<void>;
} {
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  let session: McpSession | null = null;
  let tools: readonly McpTool[] | null = null;
  let listedAt = 0;

  const target = (): McpTarget => mcpTarget(options.config, env);

  const connect = (): McpSession => {
    if (options.connect !== undefined) return options.connect();
    const where = target();
    if (where.kind === "none") throw new Error(where.reason);
    const transport =
      where.kind === "stdio"
        ? stdioTransport({ command: where.command, args: where.args, env: where.env })
        : httpTransport({
            url: where.url,
            ...(where.token === undefined ? {} : { token: where.token }),
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          });
    return mcpSession({ transport, clientName: "virtual-office" });
  };

  const open = (): McpSession => {
    if (session !== null) return session;
    const opened = connect();
    // A server that changes its mind is heard here; the cache is what acts on it.
    opened.onToolsChanged(() => {
      tools = null;
    });
    session = opened;
    return opened;
  };

  /** Drops the session so the next call opens a new one. */
  const drop = (): void => {
    const going = session;
    session = null;
    tools = null;
    void going?.close().catch(() => undefined);
  };

  const listed = async (): Promise<readonly McpTool[]> => {
    if (tools !== null && now() - listedAt < MCP_TOOLS_TTL_MS) return tools;
    const current = await open().listTools();
    tools = current;
    listedAt = now();
    return current;
  };

  return {
    async describe(): Promise<readonly DescribedTool[]> {
      let current: readonly McpTool[];
      try {
        current = await listed();
      } catch (error) {
        // One unreachable server must not empty the catalogue of the others,
        // and a model cannot do anything about a connection refused. Whoever
        // asked is told why, which is what turns this into an answer rather
        // than a connector that quietly does nothing.
        drop();
        options.onProblem?.(
          `${options.name} offered nothing: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return [];
      }
      return current.map((tool) => ({
        connectorId: options.connectorId,
        name: tool.name,
        description: tool.description ?? `${tool.name}, offered by ${options.name}`,
        inputSchema: tool.inputSchema,
        gates: declaredGates(options.config, tool),
      }));
    },

    async call(call: BrokerCall): Promise<BrokerOutcome> {
      const tool = call.name.split("__").slice(1).join("__");
      let known: readonly McpTool[];
      try {
        known = await listed();
      } catch (error) {
        drop();
        return said(
          `Could not reach ${options.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!known.some((one) => one.name === tool)) {
        return Promise.reject(new Error(`this connector has no tool "${tool}"`));
      }

      // Once, and only once: a dead server must not be tried all turn.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const outcome = await open().callTool(tool, call.input);
          return outcomeOf(options.name, tool, outcome.text, outcome.isError);
        } catch (error) {
          drop();
          if (attempt === 1) {
            return said(
              `Could not reach ${options.name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }
      return said(`Could not reach ${options.name}.`);
    },

    close(): Promise<void> {
      const going = session;
      session = null;
      tools = null;
      return going === null ? Promise.resolve() : going.close();
    },
  };
}

/** Every category an office understands, for a gate that holds all of them. */
export const ALL_GATED_ACTIONS: readonly GatedAction[] = GATED_ACTIONS;

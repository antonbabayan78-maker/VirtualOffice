/**
 * The seam between an employee calling a tool and whatever actually performs it
 * — a web connector here, an MCP server next.
 *
 * A port rather than something the orchestrator implements, for the same reason
 * `CheckRunner` and `DocumentSink` are: the engine decides who may call what,
 * and the process holding the credentials, the HTTP client and the sockets does
 * the calling. It is also what keeps every test of this offline.
 *
 * The broker returns **material**, not a filing. A fetched page comes back as an
 * artifact and the turn decides what to do with it, because a connector has no
 * business knowing what a tray is — and two connectors that both knew would
 * eventually disagree about which tray.
 *
 * Which tools an employee may call is decided here, against the office's own
 * grants, before the model is told a tool exists. That matters more than it
 * looks: `find_tool` searches this catalogue, so a tool left in it that the
 * employee cannot call is a tool the model will find, ask for, and be refused.
 */
import { resolveToolAccess, toolWireName, type GrantContext } from "@vo/core";
import type { ToolDefinition } from "@vo/llm";
import { ToolCatalog, type CatalogTool } from "./tool-catalog.js";

/** A tool as the thing that performs it describes itself. */
export interface DescribedTool extends ToolDefinition {
  /** Which connector offers it, as the office knows that connector. */
  readonly connectorId: string;
  readonly tags?: readonly string[];
}

/**
 * One call, as the model asked for it. Named apart from the run loop's `ToolUse`
 * and `ToolOutcome`, which are what an executor sees: this is the layer beneath.
 */
export interface BrokerCall {
  /** The wire name the model used: `connector__tool`. */
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Something a tool produced that belongs on a desk rather than in a sentence. */
export interface BrokerArtifact {
  readonly name: string;
  readonly mediaType: string;
  readonly content: string;
}

export interface BrokerOutcome {
  /** What to tell the model. Short: this text is in every later request. */
  readonly summary: string;
  /** The whole of what came back, if it is worth keeping. */
  readonly artifact?: BrokerArtifact;
}

export interface ToolBroker {
  /** What the connectors this process holds can actually do, right now. */
  describe(): Promise<readonly DescribedTool[]>;
  call(call: BrokerCall): Promise<BrokerOutcome>;
}

/** A described tool with a plain schema, for the common single-argument case. */
export function describedTool(
  connectorId: string,
  tool: string,
  description: string,
  inputSchema: ToolDefinition["inputSchema"] = { type: "object", properties: {} },
): DescribedTool {
  return { connectorId, name: tool, description, inputSchema };
}

/**
 * Every tool this employee may call, named as the model will see it.
 *
 * The intersection of two lists that are allowed to disagree: what the office
 * granted, and what the running connectors say they offer. A grant for
 * something nothing offers is not callable; something offered that nobody
 * granted is not offered on.
 */
export function catalogFor(
  grants: GrantContext,
  described: readonly DescribedTool[],
  extra: readonly CatalogTool[] = [],
): ToolCatalog {
  const names = new Map(
    grants.connectors.map((connector) => [connector.id as string, connector.name]),
  );
  const offered = new Map(
    described.map((tool) => [`${tool.connectorId}.${tool.name}`, tool] as const),
  );

  const tools: CatalogTool[] = [];
  for (const granted of resolveToolAccess(grants)) {
    const tool = offered.get(`${granted.connectorId}.${granted.tool}`);
    const connectorName = names.get(granted.connectorId);
    if (tool === undefined || connectorName === undefined) continue;
    tools.push({
      ...tool,
      name: toolWireName(connectorName, granted.tool),
      connectorId: granted.connectorId,
    });
  }
  return new ToolCatalog([...tools, ...extra]);
}

/** A broker with canned answers, for tests and for dry runs. */
export function recordingToolBroker(outcomes: Readonly<Record<string, BrokerOutcome>>): {
  readonly broker: ToolBroker;
  readonly calls: BrokerCall[];
  readonly described: DescribedTool[];
} {
  const calls: BrokerCall[] = [];
  const described: DescribedTool[] = [];
  return {
    calls,
    described,
    broker: {
      describe: () => Promise.resolve(described),
      call(call) {
        calls.push(call);
        const outcome = outcomes[call.name];
        if (outcome === undefined) {
          return Promise.reject(new Error(`no outcome scripted for "${call.name}"`));
        }
        return Promise.resolve(outcome);
      },
    },
  };
}

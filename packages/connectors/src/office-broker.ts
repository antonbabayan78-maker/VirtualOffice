/**
 * One broker for a whole office.
 *
 * An office has several connectors and a model makes one call; something has to
 * say which connector a call belongs to. That is the connector's name, which is
 * already the prefix on every tool it offers, so routing is a lookup rather
 * than a registry.
 *
 * A kind nothing can perform yet is passed over rather than refused. An office
 * with a REST connector configured is not an office that cannot run — it is an
 * office whose REST tools are not available yet, and saying so by leaving them
 * out of the catalogue is the honest version of that.
 *
 * Two kinds can be performed now: reading a page, and whatever an MCP server
 * offers. Nothing here starts a process or opens a socket — an MCP connector
 * does that when it is first asked something, so building this for an office
 * with six connectors costs nothing.
 */
import { splitToolWireName, type Connector } from "@vo/core";
import type { BrokerCall, BrokerOutcome, DescribedTool, ToolBroker } from "@vo/orchestrator";
import { mcpBroker, type McpConnect } from "./mcp/mcp-connector.js";
import { webBroker, type WebFetch } from "./web/web-connector.js";

export interface OfficeBrokerOptions {
  readonly fetch?: WebFetch;
  /** Builds an MCP session instead of connecting for real; for tests. */
  readonly connect?: McpConnect;
  /** Where a credential named by a connector is read from. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function brokerFor(connector: Connector, options: OfficeBrokerOptions): ToolBroker | null {
  if (connector.kind === "web") {
    return webBroker({
      connectorId: connector.id,
      name: connector.name,
      config: connector.config,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  if (connector.kind === "mcp") {
    return mcpBroker({
      connectorId: connector.id,
      name: connector.name,
      config: connector.config,
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }
  return null;
}

export function officeBroker(
  connectors: readonly Connector[],
  options: OfficeBrokerOptions = {},
): ToolBroker {
  const byName = new Map<string, ToolBroker>();
  for (const connector of connectors) {
    if (!connector.enabled) continue;
    const broker = brokerFor(connector, options);
    if (broker !== null) byName.set(connector.name, broker);
  }

  return {
    async describe(): Promise<readonly DescribedTool[]> {
      const each = await Promise.all([...byName.values()].map((broker) => broker.describe()));
      return each.flat();
    },

    call(call: BrokerCall): Promise<BrokerOutcome> {
      const split = splitToolWireName(call.name);
      const broker = split === null ? undefined : byName.get(split.connector);
      if (broker === undefined) {
        return Promise.reject(new Error(`this office has no connector for "${call.name}"`));
      }
      return broker.call(call);
    },
  };
}

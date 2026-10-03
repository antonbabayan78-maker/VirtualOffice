/**
 * What a worker can actually reach, on behalf of the office it serves.
 *
 * The catalogue an employee is offered is built per job, from the office's
 * connectors as they stand. The broker that performs a call is built once, when
 * the worker starts — before any office has been read. A broker built from
 * nothing at that moment would offer tools it then refused to perform, which is
 * a failure the model cannot do anything about and cannot see coming.
 *
 * So it asks each time rather than remembering: a connector switched off on the
 * canvas stops working without restarting the worker, which is what somebody
 * switching it off expects. Offices are small and this is one request beside a
 * model call.
 *
 * What it does remember is the broker, for as long as the answer is the same
 * one. A connector can be a process — an MCP server is — so building a new
 * broker for every describe and every call would spawn one per call and close
 * none of them. When the office's answer changes, the old broker is closed and
 * a new one takes its place, which is the same thing switching a connector off
 * is supposed to mean.
 */
import type { ApiClient } from "@vo/api-client";
import type { Connector } from "@vo/core";
import {
  officeBroker,
  type McpConnect,
  type OfficeToolBroker,
  type WebFetch,
} from "@vo/connectors";
import type { BrokerCall, BrokerOutcome, DescribedTool, ToolBroker } from "@vo/orchestrator";

export interface OfficeToolsOptions {
  readonly fetch?: WebFetch;
  /** Opens an MCP session instead of connecting for real; for tests. */
  readonly connect?: McpConnect;
  /**
   * Told why a connector is offering nothing. Without this a server that will
   * not start means a turn with an empty catalogue and nothing anywhere to
   * explain it.
   */
  readonly onProblem?: (message: string) => void;
}

export function officeTools(
  api: ApiClient,
  officeId: string,
  options: OfficeToolsOptions = {},
): ToolBroker {
  let held: { readonly of: string; readonly broker: OfficeToolBroker } | null = null;

  /** What this office can reach, as one string: a broker is good while it holds. */
  const signatureOf = (connectors: readonly Connector[]): string =>
    JSON.stringify(
      connectors.map((connector) => [
        connector.id,
        connector.name,
        connector.kind,
        connector.enabled,
        connector.config,
      ]),
    );

  const current = async (): Promise<ToolBroker> => {
    const listed = await api.listConnectors(officeId);
    if (!listed.ok) options.onProblem?.(`the office did not say what it can reach`);
    // An office that cannot say what it has reaches nothing, rather than a job
    // that fails: the work is still doable, just without tools.
    const connectors = listed.ok ? listed.value : [];
    const of = signatureOf(connectors);
    if (held !== null && held.of === of) return held.broker;

    const going = held?.broker;
    held = {
      of,
      broker: officeBroker(connectors, {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.connect === undefined ? {} : { connect: options.connect }),
        ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
      }),
    };
    // After the new one is in place: closing is a process going away, and a
    // call arriving meanwhile should find the office's current reach.
    await going?.close();
    return held.broker;
  };

  return {
    async describe(): Promise<readonly DescribedTool[]> {
      return (await current()).describe();
    },
    async call(call: BrokerCall): Promise<BrokerOutcome> {
      return (await current()).call(call);
    },
  };
}

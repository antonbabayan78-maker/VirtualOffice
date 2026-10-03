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
 */
import type { ApiClient } from "@vo/api-client";
import { officeBroker, type WebFetch } from "@vo/connectors";
import type { BrokerCall, BrokerOutcome, DescribedTool, ToolBroker } from "@vo/orchestrator";

export interface OfficeToolsOptions {
  readonly fetch?: WebFetch;
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
  const current = async (): Promise<ToolBroker> => {
    const listed = await api.listConnectors(officeId);
    if (!listed.ok) options.onProblem?.(`the office did not say what it can reach`);
    // An office that cannot say what it has reaches nothing, rather than a job
    // that fails: the work is still doable, just without tools.
    return officeBroker(listed.ok ? listed.value : [], {
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.onProblem === undefined ? {} : { onProblem: options.onProblem }),
    });
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

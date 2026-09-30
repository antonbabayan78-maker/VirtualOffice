/**
 * Assembling a worker for one office.
 *
 * The pieces are all tested on their own; this is the wiring that says which
 * ones go together — read the office over the API, run the same agent turn a
 * headless run uses, report back over the API. It exists as a function so a
 * deployment's entry point stays three lines of process handling.
 *
 * The queue is in-process, which means one worker per office for now. Swapping
 * in the Redis-backed queue is a change to this line and nothing else, which is
 * the point of the queue contract.
 */
import { createApiClient, type ApiClient } from "@vo/api-client";
import { defaultModelRegistry, type LlmProvider } from "@vo/llm";
import { meterProvider, UsageRecorder, type UsageAttribution } from "@vo/telemetry";
import { InProcessJobQueue, Worker, llmAgentTurn } from "@vo/orchestrator";
import type { WorkerConfig } from "./config.js";
import { officeSource } from "./office-source.js";
import { officeJobHandler } from "./job-handler.js";
import { apiDocumentSink } from "./document-sink.js";
import { officeTools } from "./office-tools.js";
import { apiUsageSink } from "./usage-sink.js";

export interface OfficeWorkerOptions {
  readonly config: WorkerConfig;
  readonly provider: LlmProvider;
  /** Told about anything dropped on purpose: a refused event, an office that was down. */
  readonly onProblem?: (message: string) => void;
  readonly id?: string;
  /** Injected so a whole tick can be driven offline, as the API client's is. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Wraps a provider so every call it makes is priced and sent to the office.
 *
 * Its own function because it is the thing worth testing: a worker measured
 * nothing at all until now, and "the provider handed to the turn is a metered
 * one" is an assertion, while "the worker was constructed" is not.
 */
export function meteredProvider(
  api: ApiClient,
  onProblem?: (message: string) => void,
): (provider: LlmProvider, attribution: UsageAttribution) => LlmProvider {
  const recorder = new UsageRecorder({
    sink: apiUsageSink(api, onProblem),
    // One price list serves the bill, the budget and the bench record.
    registry: defaultModelRegistry(),
  });
  return (provider, attribution) => meterProvider(provider, { recorder, attribution });
}

export function createOfficeWorker(options: OfficeWorkerOptions): Worker {
  const api = createApiClient({
    baseUrl: options.config.baseUrl,
    token: options.config.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const problem = options.onProblem ?? ((): void => undefined);

  return new Worker({
    id: options.id ?? `worker-${options.config.officeId}`,
    queue: new InProcessJobQueue(),
    snapshot: officeSource({ api, officeId: options.config.officeId, onProblem: problem }),
    handle: officeJobHandler({
      api,
      // Filing goes through the office like everything else a worker writes.
      agent: llmAgentTurn({
        provider: options.provider,
        // Until this, a worker spent money and recorded none of it: the hook
        // has always been here and the CLI has always used it.
        wrapProvider: meteredProvider(api, problem),
        documents: apiDocumentSink(api),
        // Asks the office what it can reach each time: this is built before any
        // office has been read, and a connector switched off on the canvas
        // should stop working without restarting the worker.
        tools: officeTools(api, options.config.officeId),
      }),
      onProblem: problem,
    }),
    batchSize: options.config.batchSize,
  });
}

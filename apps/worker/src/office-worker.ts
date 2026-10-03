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
import { defaultModelRegistry, type LlmProvider, type ModelRegistry } from "@vo/llm";
import { meterProvider, UsageRecorder, type UsageAttribution } from "@vo/telemetry";
import {
  InProcessJobQueue,
  Worker,
  llmAgentTurn,
  llmJudgeTurn,
  llmRetrospectiveTurn,
} from "@vo/orchestrator";
import type { WorkerConfig } from "./config.js";
import { officeProviders, type OfficeProviders } from "./office-providers.js";
import { officeSource } from "./office-source.js";
import { officeJobHandler } from "./job-handler.js";
import { apiDocumentSink } from "./document-sink.js";
import { officeTools } from "./office-tools.js";
import { apiRunCheckpoints } from "./run-state.js";
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
  /**
   * What the office's own services cost, read afresh for every call that is
   * priced. Without one, only the models the office was born knowing are
   * priced and a call on anything else is honestly reported as unpriced.
   */
  prices?: () => ModelRegistry,
): (provider: LlmProvider, attribution: UsageAttribution) => LlmProvider {
  const recorder = new UsageRecorder({
    sink: apiUsageSink(api, onProblem),
    // One price list serves the bill, the budget and the bench record.
    registry: prices ?? defaultModelRegistry(),
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

  /**
   * The office's own AI services, asked for each turn.
   *
   * A deployment's `provider` is what a turn falls back to — the office's
   * built-in Anthropic, or the rehearsal provider where there is no key at all.
   * An employee who names one of the office's services gets that one, and the
   * call is priced with what the owner said it costs.
   */
  const providers: OfficeProviders = officeProviders(api, options.config.officeId, {
    env: process.env,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    onProblem: problem,
  });

  return new Worker({
    id: options.id ?? `worker-${options.config.officeId}`,
    queue: new InProcessJobQueue(),
    snapshot: officeSource({ api, officeId: options.config.officeId, onProblem: problem }),
    handle: officeJobHandler({
      api,
      // Filing goes through the office like everything else a worker writes.
      agent: llmAgentTurn({
        provider: options.provider,
        providerFor: providers.lookup,
        // Until this, a worker spent money and recorded none of it: the hook
        // has always been here and the CLI has always used it.
        wrapProvider: meteredProvider(api, problem, providers.prices),
        documents: apiDocumentSink(api),
        // Asks the office what it can reach each time: this is built before any
        // office has been read, and a connector switched off on the canvas
        // should stop working without restarting the worker.
        tools: officeTools(api, options.config.officeId, { onProblem: problem }),
        // Where a run that stopped for a person is kept. At the office rather
        // than in this process, because the person may answer after this
        // worker has been restarted or replaced.
        checkpoints: apiRunCheckpoints(api, problem),
      }),
      // The third kind of turn. Metered the same way, and with no document sink
      // or tools at all: a judge reads the answers and says which won.
      judge: llmJudgeTurn({
        provider: options.provider,
        providerFor: providers.lookup,
        wrapProvider: meteredProvider(api, problem, providers.prices),
      }),
      // The fourth: looking back over one person's finished work, for whoever
      // the office switched on. Metered like the rest, and on their own model,
      // because it is their record being read and their bill it lands on.
      retrospective: llmRetrospectiveTurn({
        provider: options.provider,
        providerFor: providers.lookup,
        wrapProvider: meteredProvider(api, problem, providers.prices),
      }),
      onProblem: problem,
    }),
    batchSize: options.config.batchSize,
  });
}

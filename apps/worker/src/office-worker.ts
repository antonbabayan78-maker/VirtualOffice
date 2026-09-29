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
import { createApiClient } from "@vo/api-client";
import type { LlmProvider } from "@vo/llm";
import { InProcessJobQueue, Worker, llmAgentTurn } from "@vo/orchestrator";
import type { WorkerConfig } from "./config.js";
import { officeSource } from "./office-source.js";
import { officeJobHandler } from "./job-handler.js";
import { apiDocumentSink } from "./document-sink.js";
import { officeTools } from "./office-tools.js";

export interface OfficeWorkerOptions {
  readonly config: WorkerConfig;
  readonly provider: LlmProvider;
  /** Told about anything dropped on purpose: a refused event, an office that was down. */
  readonly onProblem?: (message: string) => void;
  readonly id?: string;
}

export function createOfficeWorker(options: OfficeWorkerOptions): Worker {
  const api = createApiClient({ baseUrl: options.config.baseUrl, token: options.config.token });
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

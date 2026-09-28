/**
 * @vo/worker
 *
 * The deployable worker: a loop around one tick. Run as many as the office
 * needs — they compete for one scheduler lease, so exactly one decides what is
 * due while all of them work the queue (plan §2.5 (1, 8)).
 *
 * Everything the loop needs is injected, including how to sleep, so its
 * behaviour is testable without waiting for real time to pass. Wiring the
 * queue, stores and handler from configuration belongs to a deployment; this
 * module is the part that has to be right.
 */
import type { TickReport } from "@vo/orchestrator";

export const PACKAGE_NAME = "@vo/worker" as const;

/**
 * Well under the scheduler lease, so a leader that is merely idle keeps
 * renewing and leadership does not bounce between workers for no reason.
 */
export const DEFAULT_TICK_INTERVAL_MS = 1_000;

export interface Tickable {
  tick(): Promise<TickReport>;
}

export interface Resignable {
  resign(): Promise<void>;
}

export interface WorkerLoopOptions {
  readonly worker: Tickable;
  /** Stops the loop; a deployment wires this to SIGTERM. */
  readonly signal: AbortSignal;
  readonly sleep: (ms: number) => Promise<void>;
  readonly intervalMs?: number;
  /**
   * The worker's batch size. A tick that filled its batch means more work is
   * waiting, so the loop goes straight round again instead of sleeping.
   */
  readonly batchSize?: number;
  /** Resigned from on the way out, so a planned stop hands over at once. */
  readonly election?: Resignable;
  readonly onTick?: (report: TickReport) => void;
  readonly onError?: (error: Error) => void;
}

export interface WorkerLoopSummary {
  readonly ticks: number;
  readonly processed: number;
  readonly enqueued: number;
  readonly failedTicks: number;
}

export async function runWorkerLoop(options: WorkerLoopOptions): Promise<WorkerLoopSummary> {
  const interval = options.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  let ticks = 0;
  let processed = 0;
  let enqueued = 0;
  let failedTicks = 0;
  // Read through a function: the flag changes under us while a tick is running.
  const stopping = (): boolean => options.signal.aborted;

  while (!stopping()) {
    let busy = false;
    try {
      const report = await options.worker.tick();
      ticks += 1;
      processed += report.processed;
      enqueued += report.enqueued;
      options.onTick?.(report);
      busy = options.batchSize !== undefined && report.processed >= options.batchSize;
    } catch (error) {
      // A worker that dies on one bad tick is worse than one that tries again.
      ticks += 1;
      failedTicks += 1;
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    if (stopping()) break;
    if (!busy) await options.sleep(interval);
  }

  // Hand the lease back rather than making the next worker wait it out.
  await options.election?.resign();

  return { ticks, processed, enqueued, failedTicks };
}

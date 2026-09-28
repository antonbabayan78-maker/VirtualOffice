/**
 * The worker tick: what a deployed worker process does, once.
 *
 * Every worker returns jobs whose holders died, works through a batch of the
 * queue, and — if it is the leader — schedules what is due. Followers are not
 * idle: they process what the leader queued, which is how adding workers adds
 * throughput while scheduling stays single-writer.
 *
 * A tick is a function, not a loop, so tests drive it a step at a time with no
 * timers. The loop lives in apps/worker, where it belongs.
 */
import { enqueueDueWork, type SchedulerSnapshot, type SkippedWork } from "../schedule/scheduler.js";
import type { Job, JobQueue } from "../queue/types.js";
import type { LeaderElection } from "./leader.js";

export type JobHandler = (job: Job) => Promise<void>;

export const DEFAULT_BATCH_SIZE = 4;

export interface WorkerOptions {
  /** Identifies this worker in the election and in reports. */
  readonly id: string;
  readonly queue: JobQueue;
  /** Absent means this worker always schedules: the single-process case. */
  readonly election?: LeaderElection;
  /**
   * Reads the state a tick schedules from. Called only when this worker leads,
   * so followers cost nothing to run.
   */
  readonly snapshot?: () => Promise<SchedulerSnapshot>;
  readonly handle: JobHandler;
  /** Jobs to take per tick. */
  readonly batchSize?: number;
  /** Told which recurring occurrences fired, so they can be recorded. */
  readonly onRecurringFired?: (
    fired: readonly { readonly id: string; readonly dueAt: number }[],
  ) => Promise<void>;
  readonly now?: () => Date;
}

export interface JobFailure {
  readonly jobId: string;
  readonly kind: string;
  readonly error: string;
}

export interface TickReport {
  readonly leader: boolean;
  readonly enqueued: number;
  readonly deduplicated: number;
  readonly processed: number;
  readonly failed: number;
  /** Jobs taken back from workers that went away. */
  readonly recovered: number;
  readonly skipped: readonly SkippedWork[];
  readonly errors: readonly JobFailure[];
}

export class Worker {
  constructor(private readonly options: WorkerOptions) {}

  async tick(): Promise<TickReport> {
    const now = (this.options.now ?? (() => new Date()))();
    const batchSize = Math.max(1, this.options.batchSize ?? DEFAULT_BATCH_SIZE);

    const recovered = await this.options.queue.recoverExpired();

    const leader =
      this.options.election === undefined ? true : await this.options.election.campaign();

    let enqueued = 0;
    let deduplicated = 0;
    let skipped: readonly SkippedWork[] = [];
    if (leader && this.options.snapshot !== undefined) {
      const due = await enqueueDueWork(this.options.queue, await this.options.snapshot(), now);
      enqueued = due.enqueued;
      deduplicated = due.deduplicated;
      skipped = due.skipped;
      if (due.recurringFired.length > 0 && this.options.onRecurringFired !== undefined) {
        await this.options.onRecurringFired(due.recurringFired);
      }
    }

    let processed = 0;
    const errors: JobFailure[] = [];
    for (let taken = 0; taken < batchSize; taken++) {
      const lease = await this.options.queue.claim();
      if (lease === null) break;
      try {
        await this.options.handle(lease.job);
        await this.options.queue.complete(lease.leaseId);
        processed += 1;
      } catch (error) {
        // One bad job does not end the tick; the queue decides about retrying.
        const message = error instanceof Error ? error.message : String(error);
        await this.options.queue.fail(lease.leaseId, message);
        errors.push({ jobId: lease.job.id, kind: lease.job.kind, error: message });
      }
    }

    return {
      leader,
      enqueued,
      deduplicated,
      processed,
      failed: errors.length,
      recovered,
      skipped,
      errors,
    };
  }
}

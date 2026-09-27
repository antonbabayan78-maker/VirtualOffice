/**
 * Job queue contract.
 *
 * Work reaches an employee through a queue so the office can run on more than
 * one process and survive losing any of them. Two properties matter most at the
 * scale the plan targets (§2.5): an office with 80 employees must not try to run
 * 80 agents at once, and one busy office must not starve the others.
 *
 * Delivery is at-least-once, which is the honest guarantee a queue can give
 * across a crash. Callers make their work idempotent; `idempotencyKey` and the
 * stale-lease rules here are what let them.
 */
import type { EmployeeId, OfficeId } from "@vo/core";

declare const jobIdBrand: unique symbol;
export type JobId = string & { readonly [jobIdBrand]: true };

export interface JobSpec {
  readonly officeId: OfficeId;
  /** Whose work this is. One job per employee runs at a time by default. */
  readonly employeeId?: EmployeeId | null;
  /** What to do: "agent_run", "scheduler_tick", "compaction". */
  readonly kind: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Higher runs first; 0 by default. Added to the office's own priority. */
  readonly priority?: number;
  /** Two enqueues with the same key are the same job, not two. */
  readonly idempotencyKey?: string;
  /** Epoch ms before which the job must not run. */
  readonly runAt?: number;
  readonly maxAttempts?: number;
}

export interface Job {
  readonly id: JobId;
  readonly officeId: OfficeId;
  readonly employeeId: EmployeeId | null;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly priority: number;
  readonly idempotencyKey: string | null;
  /** How many times this job has been claimed, including the current attempt. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: number;
  readonly enqueuedAt: number;
}

export interface EnqueueResult {
  readonly job: Job;
  /** True when an existing job with the same idempotency key was returned. */
  readonly deduplicated: boolean;
}

export interface Lease {
  readonly leaseId: string;
  readonly job: Job;
  /** After this the lease is stale and the job may be handed to someone else. */
  readonly expiresAt: number;
}

export interface DeadJob {
  readonly job: Job;
  readonly error: string;
  readonly deadAt: number;
}

export interface ConcurrencyLimits {
  /** Jobs in flight across the whole queue. */
  readonly maxInFlight?: number;
  readonly maxPerOffice?: number;
  /** Defaults to 1: an agent does one thing at a time. */
  readonly maxPerEmployee?: number;
}

export interface JobQueueConfig {
  readonly limits?: ConcurrencyLimits;
  /** How long a claim is held before it goes stale. Default 30s. */
  readonly leaseMs?: number;
  /** First retry delay; doubles per attempt. Default 1s. */
  readonly retryBackoffMs?: number;
  /** Default attempts per job before the dead letter. Default 3. */
  readonly maxAttempts?: number;
  /** Standing priority per office, added to each job's own. */
  readonly officePriority?: Readonly<Record<string, number>>;
  /** How long a completed job's idempotency key keeps deduplicating. Default 1h. */
  readonly dedupeMs?: number;
}

export interface OfficeQueueStats {
  readonly pending: number;
  readonly inFlight: number;
}

export interface QueueStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly dead: number;
  readonly byOffice: Readonly<Record<string, OfficeQueueStats>>;
}

export interface JobQueue {
  enqueue(spec: JobSpec): Promise<EnqueueResult>;
  /**
   * The next job that is due and within every concurrency limit, or null. Highest
   * effective priority first; among equals the office with least work in flight,
   * so no office starves; then oldest first.
   */
  claim(options?: { readonly leaseMs?: number }): Promise<Lease | null>;
  /** Finishes the job. False when the lease is stale, so a late ack is harmless. */
  complete(leaseId: string): Promise<boolean>;
  /** Hands the job back to be retried, or to the dead letter past its attempts. */
  fail(leaseId: string, error: string): Promise<boolean>;
  /** Returns expired leases to the queue; how a crashed worker's job comes back. */
  recoverExpired(): Promise<number>;
  stats(): Promise<QueueStats>;
  deadLetters(): Promise<readonly DeadJob[]>;
}

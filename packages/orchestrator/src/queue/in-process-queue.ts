/**
 * In-process job queue: the default for a single-process office, and the
 * reference implementation of the contract. State lives in memory, so it goes
 * when the process does — a deployment that must survive a restart runs the
 * Redis-backed adapter instead, against this same contract.
 *
 * Claim order is deliberate: highest effective priority, then the office with
 * least work in flight so a busy office cannot starve a quiet one, then oldest
 * first. Nothing here loops or waits; a worker asks for work and gets an answer.
 */
import { randomUUID } from "node:crypto";
import type {
  DeadJob,
  EnqueueResult,
  Job,
  JobId,
  JobQueue,
  JobQueueConfig,
  JobSpec,
  Lease,
  OfficeQueueStats,
  QueueStats,
} from "./types.js";

export interface InProcessQueueDeps {
  readonly now?: () => number;
  readonly id?: () => string;
}

const DEFAULTS = {
  leaseMs: 30_000,
  retryBackoffMs: 1_000,
  maxAttempts: 3,
  dedupeMs: 3_600_000,
  maxPerEmployee: 1,
} as const;

interface ActiveLease {
  readonly leaseId: string;
  readonly job: Job;
  readonly expiresAt: number;
}

export class InProcessJobQueue implements JobQueue {
  private readonly now: () => number;
  private readonly newId: () => string;
  private pending: Job[] = [];
  /**
   * Enqueue order per job id. Wall-clock milliseconds are far too coarse to
   * order jobs — a burst all lands on the same tick — so FIFO is decided by
   * this, never by the job id, which would make the order arbitrary.
   */
  private readonly order = new Map<JobId, number>();
  private sequence = 0;
  private readonly leases = new Map<string, ActiveLease>();
  private readonly dead: DeadJob[] = [];
  /** idempotency key -> the job it stands for, and when it may be forgotten. */
  private readonly keys = new Map<string, { readonly job: Job; forgetAt: number | null }>();

  constructor(
    private readonly config: JobQueueConfig = {},
    deps: InProcessQueueDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.id ?? (() => randomUUID());
  }

  enqueue(spec: JobSpec): Promise<EnqueueResult> {
    const now = this.now();
    this.forgetStaleKeys(now);

    const key = spec.idempotencyKey;
    if (key !== undefined) {
      const existing = this.keys.get(key);
      if (existing) return Promise.resolve({ job: existing.job, deduplicated: true });
    }

    const job: Job = {
      id: this.newId() as JobId,
      officeId: spec.officeId,
      employeeId: spec.employeeId ?? null,
      kind: spec.kind,
      payload: spec.payload ?? {},
      priority: spec.priority ?? 0,
      idempotencyKey: key ?? null,
      attempts: 0,
      maxAttempts: spec.maxAttempts ?? this.config.maxAttempts ?? DEFAULTS.maxAttempts,
      runAt: spec.runAt ?? now,
      enqueuedAt: now,
    };
    this.pending.push(job);
    this.sequence += 1;
    this.order.set(job.id, this.sequence);
    if (key !== undefined) this.keys.set(key, { job, forgetAt: null });
    return Promise.resolve({ job, deduplicated: false });
  }

  claim(options: { readonly leaseMs?: number } = {}): Promise<Lease | null> {
    const now = this.now();
    const inFlight = [...this.leases.values()];
    const limits = this.config.limits ?? {};
    const maxPerEmployee = limits.maxPerEmployee ?? DEFAULTS.maxPerEmployee;

    if (limits.maxInFlight !== undefined && inFlight.length >= limits.maxInFlight) {
      return Promise.resolve(null);
    }

    const perOffice = new Map<string, number>();
    const perEmployee = new Map<string, number>();
    for (const lease of inFlight) {
      perOffice.set(lease.job.officeId, (perOffice.get(lease.job.officeId) ?? 0) + 1);
      const employee = this.employeeKey(lease.job);
      if (employee !== null) perEmployee.set(employee, (perEmployee.get(employee) ?? 0) + 1);
    }

    const eligible = this.pending.filter((job) => {
      if (job.runAt > now) return false;
      if (
        limits.maxPerOffice !== undefined &&
        (perOffice.get(job.officeId) ?? 0) >= limits.maxPerOffice
      ) {
        return false;
      }
      const employee = this.employeeKey(job);
      if (employee !== null && (perEmployee.get(employee) ?? 0) >= maxPerEmployee) return false;
      return true;
    });

    const next = eligible.sort((a, b) => {
      const byPriority = this.effectivePriority(b) - this.effectivePriority(a);
      if (byPriority !== 0) return byPriority;
      // Least busy office first, so a quiet office is never starved by a loud one.
      const byLoad = (perOffice.get(a.officeId) ?? 0) - (perOffice.get(b.officeId) ?? 0);
      if (byLoad !== 0) return byLoad;
      return (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0);
    })[0];
    if (next === undefined) return Promise.resolve(null);

    this.pending = this.pending.filter((job) => job.id !== next.id);
    const claimed: Job = { ...next, attempts: next.attempts + 1 };
    const lease: ActiveLease = {
      leaseId: this.newId(),
      job: claimed,
      expiresAt: now + (options.leaseMs ?? this.config.leaseMs ?? DEFAULTS.leaseMs),
    };
    this.leases.set(lease.leaseId, lease);
    this.rememberKey(claimed);
    return Promise.resolve({ leaseId: lease.leaseId, job: claimed, expiresAt: lease.expiresAt });
  }

  complete(leaseId: string): Promise<boolean> {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return Promise.resolve(false);
    this.leases.delete(leaseId);
    this.order.delete(lease.job.id);
    const key = lease.job.idempotencyKey;
    if (key !== null) {
      // Remembered a while longer, so a redelivery of finished work does nothing.
      this.keys.set(key, {
        job: lease.job,
        forgetAt: this.now() + (this.config.dedupeMs ?? DEFAULTS.dedupeMs),
      });
    }
    return Promise.resolve(true);
  }

  fail(leaseId: string, error: string): Promise<boolean> {
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return Promise.resolve(false);
    this.leases.delete(leaseId);
    const now = this.now();

    if (lease.job.attempts >= lease.job.maxAttempts) {
      this.dead.push({ job: lease.job, error, deadAt: now });
      this.order.delete(lease.job.id);
      if (lease.job.idempotencyKey !== null) {
        this.keys.set(lease.job.idempotencyKey, { job: lease.job, forgetAt: null });
      }
      return Promise.resolve(true);
    }

    const backoff = this.config.retryBackoffMs ?? DEFAULTS.retryBackoffMs;
    this.pending.push({ ...lease.job, runAt: now + backoff * 2 ** (lease.job.attempts - 1) });
    return Promise.resolve(true);
  }

  recoverExpired(): Promise<number> {
    const now = this.now();
    let recovered = 0;
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt > now) continue;
      this.leases.delete(lease.leaseId);
      // The attempt is kept: at-least-once means the work may already have happened.
      this.pending.push(lease.job);
      recovered += 1;
    }
    return Promise.resolve(recovered);
  }

  stats(): Promise<QueueStats> {
    const byOffice = new Map<string, { pending: number; inFlight: number }>();
    const bump = (officeId: string, field: "pending" | "inFlight"): void => {
      const entry = byOffice.get(officeId) ?? { pending: 0, inFlight: 0 };
      entry[field] += 1;
      byOffice.set(officeId, entry);
    };
    for (const job of this.pending) bump(job.officeId, "pending");
    for (const lease of this.leases.values()) bump(lease.job.officeId, "inFlight");

    const offices: Record<string, OfficeQueueStats> = {};
    for (const [officeId, entry] of byOffice) offices[officeId] = { ...entry };
    return Promise.resolve({
      pending: this.pending.length,
      inFlight: this.leases.size,
      dead: this.dead.length,
      byOffice: offices,
    });
  }

  deadLetters(): Promise<readonly DeadJob[]> {
    return Promise.resolve([...this.dead]);
  }

  private employeeKey(job: Job): string | null {
    return job.employeeId === null ? null : `${job.officeId}/${job.employeeId}`;
  }

  private effectivePriority(job: Job): number {
    return job.priority + (this.config.officePriority?.[job.officeId] ?? 0);
  }

  private rememberKey(job: Job): void {
    if (job.idempotencyKey === null) return;
    this.keys.set(job.idempotencyKey, { job, forgetAt: null });
  }

  private forgetStaleKeys(now: number): void {
    for (const [key, entry] of this.keys) {
      if (entry.forgetAt !== null && entry.forgetAt <= now) this.keys.delete(key);
    }
  }
}

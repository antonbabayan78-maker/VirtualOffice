/**
 * Leader election for the scheduler tick (plan §2.5 (1)).
 *
 * Every worker can process jobs, but only one may decide what is due, or two
 * workers would schedule the same cron occurrence. The rule is a lease on one
 * well-known lock: whoever holds it schedules, and holding it means having
 * renewed it recently enough.
 *
 * The lease is what makes failover automatic. A leader that dies renews
 * nothing, the lease lapses, and the next worker to ask takes over — no
 * heartbeat protocol, no split brain, and no need for anyone to notice the
 * death. A leader whose own process stalled past its lease stops believing it
 * leads, which matters more than taking over quickly: it must not schedule on
 * the strength of a lease that has run out.
 */

/** The part of a coordination store an election needs; `@vo/storage`'s satisfies it. */
export interface LeaderLocks {
  /** True when acquired, or already held by this owner, refreshing the lease. */
  acquireLock(key: string, ttlMs: number, owner: string): Promise<boolean>;
  releaseLock(key: string, owner: string): Promise<boolean>;
}

/** One lock, so every worker in the deployment competes for the same thing. */
export const SCHEDULER_LOCK_KEY = "vo:scheduler:leader";

export const DEFAULT_LEASE_MS = 5_000;

export interface LeaderElectionOptions {
  readonly locks: LeaderLocks;
  /** Identifies this worker; two workers must never share one. */
  readonly owner: string;
  readonly key?: string;
  /** How long a lease lasts, and so how long a handover can take. */
  readonly leaseMs?: number;
  /** Renew once this much of the lease has gone. Default a third of it. */
  readonly renewAfterMs?: number;
  readonly now?: () => number;
}

export class LeaderElection {
  private readonly locks: LeaderLocks;
  private readonly key: string;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly renewAfterMs: number;
  private readonly now: () => number;
  private heldUntil: number | null = null;
  private renewAt = 0;

  constructor(options: LeaderElectionOptions) {
    this.locks = options.locks;
    this.owner = options.owner;
    this.key = options.key ?? SCHEDULER_LOCK_KEY;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.renewAfterMs = options.renewAfterMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether this worker may schedule right now, on its own knowledge alone. */
  get isLeader(): boolean {
    return this.heldUntil !== null && this.now() < this.heldUntil;
  }

  /**
   * Takes or keeps the lease. Cheap between renewals: a leader comfortably
   * inside its lease answers without troubling the store.
   */
  async campaign(): Promise<boolean> {
    const now = this.now();
    if (this.heldUntil !== null && now < this.renewAt) return true;

    const held = await this.locks.acquireLock(this.key, this.leaseMs, this.owner);
    if (!held) {
      this.heldUntil = null;
      return false;
    }
    this.heldUntil = now + this.leaseMs;
    this.renewAt = now + this.renewAfterMs;
    return true;
  }

  /** Steps down at once, so a planned shutdown does not cost a whole lease. */
  async resign(): Promise<void> {
    this.heldUntil = null;
    await this.locks.releaseLock(this.key, this.owner);
  }
}

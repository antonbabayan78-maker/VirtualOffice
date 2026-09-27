/**
 * The JobQueue contract, as executable tests. Every adapter runs this same
 * suite, so "in-process" and a Redis-backed queue cannot drift apart on the
 * properties callers rely on. Published for adapters outside this package.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { EmployeeId, OfficeId } from "@vo/core";
import type { JobQueue, JobQueueConfig, Lease } from "./types.js";

export interface JobQueueFactory {
  /** The queue must read time from `clock` so lease and backoff tests are exact. */
  create(clock: () => number, config: JobQueueConfig): Promise<JobQueue>;
  destroy(queue: JobQueue): Promise<void>;
}

const acme = "office-acme" as OfficeId;
const globex = "office-globex" as OfficeId;
const ada = "emp-ada" as EmployeeId;
const bob = "emp-bob" as EmployeeId;

export function jobQueueContract(name: string, factory: JobQueueFactory): void {
  describe(`JobQueue contract: ${name}`, () => {
    let now = 1_000_000;
    let queue: JobQueue;

    const open = async (config: JobQueueConfig = {}): Promise<JobQueue> => {
      queue = await factory.create(() => now, config);
      return queue;
    };

    beforeEach(() => {
      now = 1_000_000;
    });

    const claimAll = async (q: JobQueue): Promise<Lease[]> => {
      const leases: Lease[] = [];
      for (let lease = await q.claim(); lease !== null; lease = await q.claim()) {
        leases.push(lease);
      }
      return leases;
    };

    it("hands out an enqueued job and nothing when the queue is empty", async () => {
      const q = await open();
      expect(await q.claim()).toBeNull();
      const { job, deduplicated } = await q.enqueue({ officeId: acme, kind: "agent_run" });
      expect(deduplicated).toBe(false);
      const lease = await q.claim();
      expect(lease?.job.id).toBe(job.id);
      expect(lease?.job.attempts).toBe(1);
      expect(await q.claim()).toBeNull();
      await factory.destroy(q);
    });

    it("counts pending, in-flight and completed work per office", async () => {
      const q = await open();
      await q.enqueue({ officeId: acme, kind: "a" });
      await q.enqueue({ officeId: globex, kind: "b" });
      expect(await q.stats()).toMatchObject({ pending: 2, inFlight: 0, dead: 0 });

      const lease = await q.claim();
      expect(await q.stats()).toMatchObject({ pending: 1, inFlight: 1 });
      expect((await q.stats()).byOffice[lease?.job.officeId ?? ""]).toEqual({
        pending: 0,
        inFlight: 1,
      });

      expect(await q.complete(lease?.leaseId ?? "")).toBe(true);
      expect(await q.stats()).toMatchObject({ pending: 1, inFlight: 0 });
      await factory.destroy(q);
    });

    it("runs higher priority first", async () => {
      const q = await open();
      await q.enqueue({ officeId: acme, kind: "low", priority: 0 });
      await q.enqueue({ officeId: acme, kind: "urgent", priority: 10 });
      await q.enqueue({ officeId: acme, kind: "normal", priority: 5 });
      const order = (await claimAll(q)).map((l) => l.job.kind);
      expect(order).toEqual(["urgent", "normal", "low"]);
      await factory.destroy(q);
    });

    it("adds the office's standing priority to each of its jobs", async () => {
      const q = await open({ officePriority: { [globex]: 100 } });
      await q.enqueue({ officeId: acme, kind: "acme", priority: 5 });
      await q.enqueue({ officeId: globex, kind: "globex", priority: 0 });
      const order = (await claimAll(q)).map((l) => l.job.kind);
      expect(order).toEqual(["globex", "acme"]);
      await factory.destroy(q);
    });

    it("spreads equal work across offices instead of draining one", async () => {
      const q = await open();
      await q.enqueue({ officeId: acme, kind: "acme-1" });
      await q.enqueue({ officeId: acme, kind: "acme-2" });
      await q.enqueue({ officeId: globex, kind: "globex-1" });
      await q.enqueue({ officeId: globex, kind: "globex-2" });
      const offices = (await claimAll(q)).map((l) => l.job.officeId);
      expect(offices).toEqual([acme, globex, acme, globex]);
      await factory.destroy(q);
    });

    it("runs one job per employee at a time", async () => {
      const q = await open();
      await q.enqueue({ officeId: acme, employeeId: ada, kind: "first" });
      await q.enqueue({ officeId: acme, employeeId: ada, kind: "second" });
      const first = await q.claim();
      expect(first?.job.kind).toBe("first");
      expect(await q.claim()).toBeNull();
      await q.complete(first?.leaseId ?? "");
      expect((await q.claim())?.job.kind).toBe("second");
      await factory.destroy(q);
    });

    it("lets an employee run more than one job when the office allows it", async () => {
      const q = await open({ limits: { maxPerEmployee: 2 } });
      await q.enqueue({ officeId: acme, employeeId: ada, kind: "first" });
      await q.enqueue({ officeId: acme, employeeId: ada, kind: "second" });
      expect((await claimAll(q)).length).toBe(2);
      await factory.destroy(q);
    });

    it("holds an office to its own concurrency limit", async () => {
      const q = await open({ limits: { maxPerOffice: 2 } });
      for (const employeeId of [ada, bob, "emp-cyd" as EmployeeId]) {
        await q.enqueue({ officeId: acme, employeeId, kind: "work" });
      }
      await q.enqueue({ officeId: globex, kind: "elsewhere" });
      const leases = await claimAll(q);
      expect(leases.filter((l) => l.job.officeId === acme)).toHaveLength(2);
      // Another office is not blocked by a busy one.
      expect(leases.filter((l) => l.job.officeId === globex)).toHaveLength(1);
      await factory.destroy(q);
    });

    it("holds the whole queue to its in-flight limit", async () => {
      const q = await open({ limits: { maxInFlight: 2, maxPerEmployee: 5 } });
      for (let i = 0; i < 5; i++) await q.enqueue({ officeId: acme, kind: `job-${String(i)}` });
      expect(await claimAll(q)).toHaveLength(2);
      await factory.destroy(q);
    });

    it("keeps 200 queued jobs inside every limit until they are all done", async () => {
      const limits = { maxInFlight: 6, maxPerOffice: 3, maxPerEmployee: 1 };
      const q = await open({ limits });
      const offices = [acme, globex, "office-initech" as OfficeId, "office-umbrella" as OfficeId];
      let enqueued = 0;
      for (const officeId of offices) {
        for (let e = 0; e < 5; e++) {
          for (let j = 0; j < 10; j++) {
            await q.enqueue({
              officeId,
              employeeId: `emp-${String(e)}` as EmployeeId,
              kind: "run",
            });
            enqueued += 1;
          }
        }
      }
      expect(enqueued).toBe(200);

      let completed = 0;
      const held: Lease[] = [];
      for (let guard = 0; guard < 1000 && completed < 200; guard++) {
        for (let lease = await q.claim(); lease !== null; lease = await q.claim()) held.push(lease);

        const stats = await q.stats();
        expect(stats.inFlight).toBeLessThanOrEqual(limits.maxInFlight);
        for (const office of Object.values(stats.byOffice)) {
          expect(office.inFlight).toBeLessThanOrEqual(limits.maxPerOffice);
        }
        const perEmployee = new Map<string, number>();
        for (const lease of held) {
          const key = `${lease.job.officeId}/${lease.job.employeeId ?? ""}`;
          perEmployee.set(key, (perEmployee.get(key) ?? 0) + 1);
        }
        for (const count of perEmployee.values()) {
          expect(count).toBeLessThanOrEqual(limits.maxPerEmployee);
        }

        const next = held.shift();
        if (next === undefined) break;
        await q.complete(next.leaseId);
        completed += 1;
      }
      expect(completed).toBe(200);
      expect(await q.stats()).toMatchObject({ pending: 0, inFlight: 0, dead: 0 });
      await factory.destroy(q);
    });

    it("does not run a job before its time", async () => {
      const q = await open();
      await q.enqueue({ officeId: acme, kind: "later", runAt: now + 5_000 });
      expect(await q.claim()).toBeNull();
      now += 5_000;
      expect((await q.claim())?.job.kind).toBe("later");
      await factory.destroy(q);
    });

    it("retries a failed job after a growing backoff", async () => {
      const q = await open({ retryBackoffMs: 1_000, maxAttempts: 3 });
      await q.enqueue({ officeId: acme, kind: "flaky" });
      const first = await q.claim();
      expect(first?.job.kind).toBe("flaky");
      expect(await q.fail(first?.leaseId ?? "", "provider down")).toBe(true);

      expect(await q.claim()).toBeNull();
      now += 1_000;
      const second = await q.claim();
      expect(second?.job.attempts).toBe(2);

      await q.fail(second?.leaseId ?? "", "provider still down");
      now += 1_000;
      expect(await q.claim()).toBeNull();
      now += 1_000;
      expect((await q.claim())?.job.attempts).toBe(3);
      await factory.destroy(q);
    });

    it("gives up on a job after its attempts and records why", async () => {
      const q = await open({ retryBackoffMs: 0, maxAttempts: 2 });
      await q.enqueue({ officeId: acme, kind: "doomed" });
      for (let attempt = 0; attempt < 2; attempt++) {
        const lease = await q.claim();
        expect(lease).not.toBeNull();
        await q.fail(lease?.leaseId ?? "", `attempt ${String(attempt + 1)} failed`);
      }
      expect(await q.claim()).toBeNull();
      const dead = await q.deadLetters();
      expect(dead).toHaveLength(1);
      expect(dead[0]?.job.kind).toBe("doomed");
      expect(dead[0]?.error).toBe("attempt 2 failed");
      expect(await q.stats()).toMatchObject({ pending: 0, inFlight: 0, dead: 1 });
      await factory.destroy(q);
    });

    it("returns a job whose worker went away, keeping the attempt count", async () => {
      const q = await open({ leaseMs: 30_000 });
      await q.enqueue({ officeId: acme, employeeId: ada, kind: "orphan" });
      const lost = await q.claim();
      expect(lost?.job.attempts).toBe(1);

      // The worker holding it dies; nothing happens until the lease expires.
      now += 29_999;
      expect(await q.recoverExpired()).toBe(0);
      now += 1;
      expect(await q.recoverExpired()).toBe(1);

      const again = await q.claim();
      expect(again?.job.id).toBe(lost?.job.id);
      expect(again?.job.attempts).toBe(2);
      await factory.destroy(q);
    });

    it("ignores a stale lease so a returning worker cannot disturb the retry", async () => {
      const q = await open({ leaseMs: 1_000 });
      await q.enqueue({ officeId: acme, kind: "slow" });
      const stale = await q.claim();
      now += 1_001;
      await q.recoverExpired();
      const fresh = await q.claim();
      expect(fresh?.job.id).toBe(stale?.job.id);

      // The first worker finally finishes: too late, and it must not end the retry.
      expect(await q.complete(stale?.leaseId ?? "")).toBe(false);
      expect(await q.stats()).toMatchObject({ inFlight: 1 });
      expect(await q.complete(fresh?.leaseId ?? "")).toBe(true);
      expect(await q.stats()).toMatchObject({ pending: 0, inFlight: 0 });
      await factory.destroy(q);
    });

    it("treats an unknown lease as stale rather than an error", async () => {
      const q = await open();
      expect(await q.complete("nope")).toBe(false);
      expect(await q.fail("nope", "whatever")).toBe(false);
      await factory.destroy(q);
    });

    it("enqueues an idempotency key once while the work is outstanding", async () => {
      const q = await open();
      const first = await q.enqueue({
        officeId: acme,
        kind: "once",
        idempotencyKey: "task-1:step-4",
      });
      const second = await q.enqueue({
        officeId: acme,
        kind: "once",
        idempotencyKey: "task-1:step-4",
      });
      expect(second.deduplicated).toBe(true);
      expect(second.job.id).toBe(first.job.id);
      expect(await q.stats()).toMatchObject({ pending: 1 });

      // Still deduplicated while it is in flight: a redelivery must not double it.
      const lease = await q.claim();
      const third = await q.enqueue({
        officeId: acme,
        kind: "once",
        idempotencyKey: "task-1:step-4",
      });
      expect(third.deduplicated).toBe(true);
      await q.complete(lease?.leaseId ?? "");
      await factory.destroy(q);
    });

    it("keeps deduplicating a finished job for the dedupe window, then forgets it", async () => {
      const q = await open({ dedupeMs: 60_000 });
      const first = await q.enqueue({ officeId: acme, kind: "once", idempotencyKey: "k" });
      const lease = await q.claim();
      await q.complete(lease?.leaseId ?? "");

      now += 59_999;
      const repeat = await q.enqueue({ officeId: acme, kind: "once", idempotencyKey: "k" });
      expect(repeat.deduplicated).toBe(true);
      expect(repeat.job.id).toBe(first.job.id);

      now += 2;
      const afterWindow = await q.enqueue({ officeId: acme, kind: "once", idempotencyKey: "k" });
      expect(afterWindow.deduplicated).toBe(false);
      expect(afterWindow.job.id).not.toBe(first.job.id);
      await factory.destroy(q);
    });
  });
}

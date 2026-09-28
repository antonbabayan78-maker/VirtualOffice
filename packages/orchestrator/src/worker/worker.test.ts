import { describe, expect, it, vi } from "vitest";
import { InMemoryCoordinationStore } from "@vo/storage";
import type { DepartmentId, EmployeeId, OfficeId, TaskId } from "@vo/core";
import { InProcessJobQueue } from "../queue/in-process-queue.js";
import type { Job, JobQueue } from "../queue/types.js";
import type { SchedulerSnapshot } from "../schedule/scheduler.js";
import { LeaderElection } from "./leader.js";
import { Worker } from "./worker.js";

const office = "office-acme" as OfficeId;
const dept = "dept-eng" as DepartmentId;
const ada = "emp-ada" as EmployeeId;
const now = new Date("2026-09-28T09:00:00.000Z");

const snapshot = (taskCount: number, dueCount = taskCount): SchedulerSnapshot => ({
  offices: [{ id: office, schedule: { kind: "always" } }],
  departments: [{ id: dept, officeId: office, schedule: { kind: "always" } }],
  employees: [
    {
      id: ada,
      officeId: office,
      departmentId: dept,
      status: "active",
      schedule: { kind: "always" },
    },
  ],
  tasks: Array.from({ length: taskCount }, (_, i) => ({
    id: `task-${String(i)}` as TaskId,
    officeId: office,
    departmentId: dept,
    assigneeId: ada,
    // Only the first `dueCount` are the agent's move; the rest are waiting on a review.
    status: i < dueCount ? ("assigned" as const) : ("in_review" as const),
    priority: "normal" as const,
    // No named reviewer: those tasks are waiting on a person, not on an agent.
    reviewerIds: [],
    revision: 1,
  })),
  recurring: [],
});

const build = (
  overrides: Partial<ConstructorParameters<typeof Worker>[0]> = {},
): { worker: Worker; queue: JobQueue; handled: Job[] } => {
  const queue = new InProcessJobQueue(
    { limits: { maxPerEmployee: 10 } },
    { now: () => now.getTime() },
  );
  const handled: Job[] = [];
  const worker = new Worker({
    id: "worker-1",
    queue,
    handle: (job) => {
      handled.push(job);
      return Promise.resolve();
    },
    now: () => now,
    ...overrides,
  });
  return { worker, queue, handled };
};

describe("Worker", () => {
  it("queues due work and then works through it", async () => {
    const { worker, handled } = build({ snapshot: () => Promise.resolve(snapshot(2)) });
    const report = await worker.tick();
    expect(report).toMatchObject({ leader: true, enqueued: 2, processed: 2, failed: 0 });
    expect(handled).toHaveLength(2);
  });

  it("takes work off the queue even with nothing to schedule", async () => {
    const { worker, queue, handled } = build();
    await queue.enqueue({ officeId: office, employeeId: ada, kind: "agent_run" });
    const report = await worker.tick();
    expect(report).toMatchObject({ enqueued: 0, processed: 1 });
    expect(handled).toHaveLength(1);
  });

  it("only lets the leader schedule, while everyone works the queue", async () => {
    const clock = 1_000_000;
    const locks = new InMemoryCoordinationStore({ clock: () => clock });
    const queue = new InProcessJobQueue({ limits: { maxPerEmployee: 10 } }, { now: () => clock });
    const handledBy: string[] = [];
    const make = (id: string): Worker =>
      new Worker({
        id,
        queue,
        election: new LeaderElection({ locks, owner: id, leaseMs: 5_000, now: () => clock }),
        snapshot: () => Promise.resolve(snapshot(6)),
        handle: () => {
          handledBy.push(id);
          return Promise.resolve();
        },
        // Small batches, so the leader leaves work behind for the follower.
        batchSize: 2,
        now: () => now,
      });

    const first = await make("worker-1").tick();
    expect(first).toMatchObject({ leader: true, enqueued: 6, processed: 2 });

    const second = await make("worker-2").tick();
    expect(second.leader).toBe(false);
    expect(second.enqueued).toBe(0);
    // A follower is not idle: it works through what the leader queued.
    expect(second.processed).toBe(2);
    expect(handledBy).toContain("worker-2");
  });

  it("never double-schedules, even if two workers both believe they lead", async () => {
    const queue = new InProcessJobQueue(
      { limits: { maxPerEmployee: 10 } },
      { now: () => now.getTime() },
    );
    const input = snapshot(3);
    const make = (id: string): Worker =>
      new Worker({
        id,
        queue,
        snapshot: () => Promise.resolve(input),
        handle: () => Promise.resolve(),
        now: () => now,
      });

    const first = await make("worker-1").tick();
    // No election at all: both act as leader. The idempotency keys still hold.
    const second = await make("worker-2").tick();
    expect(first.enqueued).toBe(3);
    expect(second.enqueued).toBe(0);
    expect(second.deduplicated).toBe(3);
  });

  it("hands a recurring occurrence back so the caller can record it", async () => {
    const onRecurringFired = vi.fn((_fired: readonly { id: string; dueAt: number }[]) =>
      Promise.resolve(),
    );
    const withCron: SchedulerSnapshot = {
      ...snapshot(0),
      recurring: [
        {
          id: "digest",
          officeId: office,
          cron: "0 9 * * *",
          timezone: "UTC",
          kind: "daily_digest",
          lastRunAt: null,
        },
      ],
    };
    const { worker } = build({ snapshot: () => Promise.resolve(withCron), onRecurringFired });
    const report = await worker.tick();
    expect(report.enqueued).toBe(1);
    expect(onRecurringFired).toHaveBeenCalledWith([{ id: "digest", dueAt: now.getTime() }]);
  });

  it("hands a failed job back to the queue rather than losing it", async () => {
    const queue = new InProcessJobQueue({ retryBackoffMs: 1_000 }, { now: () => now.getTime() });
    const worker = new Worker({
      id: "worker-1",
      queue,
      handle: () => Promise.reject(new Error("provider down")),
      now: () => now,
    });
    await queue.enqueue({ officeId: office, kind: "agent_run" });

    const report = await worker.tick();
    expect(report).toMatchObject({ processed: 0, failed: 1 });
    expect(report.errors[0]?.error).toMatch(/provider down/);
    // Still there to try again.
    expect((await queue.stats()).pending).toBe(1);
  });

  it("keeps going through a batch when one job throws", async () => {
    const queue = new InProcessJobQueue({ retryBackoffMs: 1_000 }, { now: () => now.getTime() });
    const seen: string[] = [];
    const worker = new Worker({
      id: "worker-1",
      queue,
      handle: (job) => {
        seen.push(job.kind);
        return job.kind === "bad" ? Promise.reject(new Error("nope")) : Promise.resolve();
      },
      now: () => now,
    });
    await queue.enqueue({ officeId: office, kind: "bad" });
    await queue.enqueue({ officeId: office, kind: "good" });

    const report = await worker.tick();
    expect(seen).toEqual(["bad", "good"]);
    expect(report).toMatchObject({ processed: 1, failed: 1 });
  });

  it("does not spend the rest of the batch retrying the job that just failed", async () => {
    const queue = new InProcessJobQueue({ retryBackoffMs: 1_000 }, { now: () => now.getTime() });
    let attempts = 0;
    const worker = new Worker({
      id: "worker-1",
      queue,
      batchSize: 4,
      handle: () => {
        attempts += 1;
        return Promise.reject(new Error("still down"));
      },
      now: () => now,
    });
    await queue.enqueue({ officeId: office, kind: "flaky" });
    const report = await worker.tick();
    expect(attempts).toBe(1);
    expect(report).toMatchObject({ processed: 0, failed: 1 });
  });

  it("takes at most a batch per tick", async () => {
    const queue = new InProcessJobQueue(
      { limits: { maxPerEmployee: 10 } },
      { now: () => now.getTime() },
    );
    for (let i = 0; i < 5; i++) await queue.enqueue({ officeId: office, kind: `job-${String(i)}` });
    const worker = new Worker({
      id: "worker-1",
      queue,
      batchSize: 2,
      handle: () => Promise.resolve(),
      now: () => now,
    });
    expect((await worker.tick()).processed).toBe(2);
    expect((await queue.stats()).pending).toBe(3);
  });

  it("returns a job whose worker died, and then works it", async () => {
    let clock = now.getTime();
    const queue = new InProcessJobQueue({ leaseMs: 1_000 }, { now: () => clock });
    await queue.enqueue({ officeId: office, kind: "orphan" });
    // A worker claims it and then dies without acking.
    const lost = await queue.claim();
    expect(lost).not.toBeNull();

    const handled: Job[] = [];
    const worker = new Worker({
      id: "worker-2",
      queue,
      handle: (job) => {
        handled.push(job);
        return Promise.resolve();
      },
      now: () => new Date(clock),
    });

    // Before the lease lapses there is nothing to take on.
    expect(await worker.tick()).toMatchObject({ recovered: 0, processed: 0 });
    clock += 1_001;
    const report = await worker.tick();
    expect(report).toMatchObject({ recovered: 1, processed: 1 });
    expect(handled[0]?.kind).toBe("orphan");
    expect(handled[0]?.attempts).toBe(2);
  });

  it("costs what the due work costs, not what the office holds", async () => {
    let enqueueCalls = 0;
    let claimCalls = 0;
    const inner = new InProcessJobQueue(
      { limits: { maxPerEmployee: 10 } },
      { now: () => now.getTime() },
    );
    const counting: JobQueue = {
      enqueue: (spec) => {
        enqueueCalls += 1;
        return inner.enqueue(spec);
      },
      claim: (options) => {
        claimCalls += 1;
        return inner.claim(options);
      },
      complete: (id) => inner.complete(id),
      fail: (id, error) => inner.fail(id, error),
      recoverExpired: () => inner.recoverExpired(),
      stats: () => inner.stats(),
      deadLetters: () => inner.deadLetters(),
    };
    // 500 tasks in the office, 3 of them actually the agent's move.
    const worker = new Worker({
      id: "worker-1",
      queue: counting,
      snapshot: () => Promise.resolve(snapshot(500, 3)),
      handle: () => Promise.resolve(),
      batchSize: 10,
      now: () => now,
    });

    const report = await worker.tick();
    expect(report.enqueued).toBe(3);
    expect(enqueueCalls, "one enqueue per due task, none for the rest").toBe(3);
    // Claims are bounded by the batch, not by the size of the office.
    expect(claimCalls).toBeLessThanOrEqual(11);
  });
});

import { describe, expect, it } from "vitest";
import { InMemoryCoordinationStore } from "@vo/storage";
import { LeaderElection, SCHEDULER_LOCK_KEY } from "./leader.js";

describe("LeaderElection", () => {
  const setup = (leaseMs = 5_000) => {
    let now = 1_000_000;
    const locks = new InMemoryCoordinationStore({ clock: () => now });
    const worker = (owner: string): LeaderElection =>
      new LeaderElection({ locks, owner, leaseMs, now: () => now });
    return { worker, advance: (ms: number) => (now += ms), at: () => now };
  };

  it("makes the first worker to ask the leader", async () => {
    const { worker } = setup();
    const one = worker("worker-1");
    expect(one.isLeader).toBe(false);
    expect(await one.campaign()).toBe(true);
    expect(one.isLeader).toBe(true);
  });

  it("locks the others out while the leader holds the lease", async () => {
    const { worker } = setup();
    await worker("worker-1").campaign();
    const two = worker("worker-2");
    expect(await two.campaign()).toBe(false);
    expect(two.isLeader).toBe(false);
  });

  it("hands over within the lease when the leader stops renewing", async () => {
    const { worker, advance } = setup(5_000);
    const one = worker("worker-1");
    const two = worker("worker-2");
    await one.campaign();

    // The leader is killed: nothing renews the lease.
    advance(4_999);
    expect(await two.campaign()).toBe(false);
    advance(1);
    expect(await two.campaign()).toBe(true);
    expect(two.isLeader).toBe(true);
  });

  it("keeps the lease while the leader keeps campaigning", async () => {
    const { worker, advance } = setup(5_000);
    const one = worker("worker-1");
    const two = worker("worker-2");
    await one.campaign();

    for (let elapsed = 0; elapsed < 20_000; elapsed += 1_000) {
      advance(1_000);
      expect(await one.campaign(), `leader at +${String(elapsed)}ms`).toBe(true);
      expect(await two.campaign(), `challenger at +${String(elapsed)}ms`).toBe(false);
    }
  });

  it("stops believing it leads once its own lease has run out", async () => {
    const { worker, advance } = setup(5_000);
    const one = worker("worker-1");
    await one.campaign();
    // The process stalled: it must not act as leader on stale knowledge.
    advance(5_001);
    expect(one.isLeader).toBe(false);
  });

  it("lets the next worker straight in when the leader resigns", async () => {
    const { worker } = setup();
    const one = worker("worker-1");
    const two = worker("worker-2");
    await one.campaign();
    await one.resign();
    expect(one.isLeader).toBe(false);
    expect(await two.campaign()).toBe(true);
  });

  it("does not trouble the store between renewals", async () => {
    let now = 1_000_000;
    let calls = 0;
    const store = new InMemoryCoordinationStore({ clock: () => now });
    const locks = {
      acquireLock: (key: string, ttlMs: number, owner: string) => {
        calls += 1;
        return store.acquireLock(key, ttlMs, owner);
      },
      releaseLock: (key: string, owner: string) => store.releaseLock(key, owner),
    };
    const one = new LeaderElection({ locks, owner: "worker-1", leaseMs: 6_000, now: () => now });

    expect(await one.campaign()).toBe(true);
    expect(calls).toBe(1);
    now += 500;
    expect(await one.campaign()).toBe(true);
    expect(calls, "inside the renewal window").toBe(1);
    now += 2_000;
    expect(await one.campaign()).toBe(true);
    expect(calls, "past a third of the lease").toBe(2);
  });

  it("uses one well-known lock so every worker competes for the same one", () => {
    expect(SCHEDULER_LOCK_KEY).toBe("vo:scheduler:leader");
  });
});

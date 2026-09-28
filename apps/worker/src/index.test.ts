import { describe, expect, it, vi } from "vitest";
import type { TickReport } from "@vo/orchestrator";
import { PACKAGE_NAME, DEFAULT_TICK_INTERVAL_MS, runWorkerLoop } from "./index.js";

const report = (overrides: Partial<TickReport> = {}): TickReport => ({
  leader: true,
  enqueued: 0,
  deduplicated: 0,
  processed: 0,
  failed: 0,
  recovered: 0,
  skipped: [],
  errors: [],
  ...overrides,
});

describe("@vo/worker", () => {
  it("exports its package name", () => {
    expect(PACKAGE_NAME).toBe("@vo/worker");
  });

  it("ticks faster than a lease can lapse, so leadership is never dropped by idling", () => {
    expect(DEFAULT_TICK_INTERVAL_MS).toBeLessThan(5_000);
  });
});

describe("runWorkerLoop", () => {
  it("keeps ticking until it is told to stop", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const worker = {
      tick: () => {
        ticks += 1;
        if (ticks === 3) controller.abort();
        return Promise.resolve(report({ processed: 1 }));
      },
    };
    const sleep = vi.fn(() => Promise.resolve());

    const summary = await runWorkerLoop({
      worker,
      signal: controller.signal,
      sleep,
      intervalMs: 250,
    });

    expect(ticks).toBe(3);
    expect(summary.ticks).toBe(3);
    expect(summary.processed).toBe(3);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("does not sleep between ticks while there is more work waiting", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const worker = {
      tick: () => {
        ticks += 1;
        if (ticks === 2) controller.abort();
        // A full batch means the queue is not empty yet.
        return Promise.resolve(report({ processed: 4 }));
      },
    };
    const sleep = vi.fn(() => Promise.resolve());
    await runWorkerLoop({ worker, signal: controller.signal, sleep, batchSize: 4 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("carries on after a tick throws instead of taking the process down", async () => {
    const controller = new AbortController();
    let ticks = 0;
    const errors: Error[] = [];
    const worker = {
      tick: () => {
        ticks += 1;
        if (ticks === 3) controller.abort();
        return ticks === 1
          ? Promise.reject(new Error("database went away"))
          : Promise.resolve(report());
      },
    };

    const summary = await runWorkerLoop({
      worker,
      signal: controller.signal,
      sleep: () => Promise.resolve(),
      onError: (error) => errors.push(error),
    });

    expect(ticks).toBe(3);
    expect(summary.failedTicks).toBe(1);
    expect(errors[0]?.message).toBe("database went away");
  });

  it("stops before its first tick when it is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tick = vi.fn(() => Promise.resolve(report()));
    const summary = await runWorkerLoop({
      worker: { tick },
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    });
    expect(tick).not.toHaveBeenCalled();
    expect(summary.ticks).toBe(0);
  });

  it("resigns its leadership on the way out rather than holding a dead lease", async () => {
    const controller = new AbortController();
    const resign = vi.fn(() => Promise.resolve());
    let ticks = 0;
    await runWorkerLoop({
      worker: {
        tick: () => {
          ticks += 1;
          controller.abort();
          return Promise.resolve(report());
        },
      },
      election: { resign },
      signal: controller.signal,
      sleep: () => Promise.resolve(),
    });
    expect(ticks).toBe(1);
    expect(resign).toHaveBeenCalledTimes(1);
  });
});

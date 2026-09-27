import { describe, expect, it } from "vitest";
import type { OfficeId } from "@vo/core";
import { InProcessJobQueue } from "./in-process-queue.js";
import { jobQueueContract } from "./queue-contract.js";

jobQueueContract("in-process", {
  create: (clock, config) => Promise.resolve(new InProcessJobQueue(config, { now: clock })),
  destroy: () => Promise.resolve(),
});

describe("InProcessJobQueue", () => {
  it("reads the wall clock and generates ids when given no deps", async () => {
    const queue = new InProcessJobQueue();
    const { job } = await queue.enqueue({ officeId: "office-1" as OfficeId, kind: "work" });
    expect(job.id).toMatch(/[0-9a-f-]{36}/);
    expect(job.enqueuedAt).toBeGreaterThan(0);
    expect((await queue.claim())?.job.id).toBe(job.id);
  });
});

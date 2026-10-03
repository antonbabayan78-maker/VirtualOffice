import { describe, expect, it } from "vitest";
import type { ApiClient } from "@vo/api-client";
import type { RunCheckpoint } from "@vo/orchestrator";
import { apiRunCheckpoints } from "./run-state.js";

const checkpoint = (step = 1): RunCheckpoint & Readonly<Record<string, unknown>> =>
  ({
    runId: "task-1",
    step,
    messages: [],
    budget: { spend: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, usd: 0 } },
    spendApproved: false,
    droppedMessages: 0,
    updatedAt: 1_700_000_000_000,
  }) as unknown as RunCheckpoint & Readonly<Record<string, unknown>>;

const api = (overrides: Partial<ApiClient> = {}): ApiClient =>
  ({
    loadRunState: () => Promise.resolve({ ok: true, value: { checkpoint: null, decisions: [] } }),
    saveRunCheckpoint: () => Promise.resolve({ ok: true, value: true }),
    ...overrides,
  }) as ApiClient;

describe("a run kept at the office", () => {
  it("reads back what was saved, so another worker can take the run on", async () => {
    const store = apiRunCheckpoints(
      api({
        loadRunState: () =>
          Promise.resolve({ ok: true, value: { checkpoint: checkpoint(3), decisions: [] } }),
      }),
    );

    expect((await store.load("task-1"))?.step).toBe(3);
  });

  it("reads nothing as nothing, which is a run that has not started", async () => {
    expect(await apiRunCheckpoints(api()).load("task-1")).toBeNull();
  });

  it("sends it to the office under the run it belongs to", async () => {
    const sent: { taskId: string; step: unknown }[] = [];
    const store = apiRunCheckpoints(
      api({
        saveRunCheckpoint: (taskId, body) => {
          sent.push({ taskId, step: body["step"] });
          return Promise.resolve({ ok: true, value: true });
        },
      }),
    );

    await store.save(checkpoint(2));

    expect(sent).toEqual([{ taskId: "task-1", step: 2 }]);
  });

  it("says so but carries on when the office will not keep it", async () => {
    // A run must not die because a checkpoint could not be written: the work is
    // still being done, it just cannot be resumed elsewhere. Silence here would
    // be a parked run that never comes back and nothing to explain it.
    const problems: string[] = [];
    const store = apiRunCheckpoints(
      api({
        saveRunCheckpoint: () =>
          Promise.resolve({ ok: false, kind: "transport", message: "no route to the office" }),
      }),
      (message) => problems.push(message),
    );

    await expect(store.save(checkpoint())).resolves.toBeUndefined();
    expect(problems.join()).toContain("no route");
  });

  it("says so when it cannot read one either", async () => {
    const problems: string[] = [];
    const store = apiRunCheckpoints(
      api({
        loadRunState: () =>
          Promise.resolve({ ok: false, kind: "transport", message: "no route to the office" }),
      }),
      (message) => problems.push(message),
    );

    expect(await store.load("task-1")).toBeNull();
    expect(problems.join()).toContain("no route");
  });

  it("deletes nothing, because the office clears a spent run itself", async () => {
    // Said out loud rather than left as a surprise: the lifecycle belongs to
    // whoever applies the transitions, which is the office.
    expect(await apiRunCheckpoints(api()).delete("task-1")).toBe(false);
  });
});

describe("what a person decided, on the way into a turn", () => {
  it("is read from the office along with the run", async () => {
    const { runDecisions } = await import("./run-state.js");
    const decisions = [{ key: "call-1", decision: "approved" as const, decidedBy: "owner-1" }];

    const read = await runDecisions(
      api({
        loadRunState: () => Promise.resolve({ ok: true, value: { checkpoint: null, decisions } }),
      }),
      "task-1",
    );

    expect(read).toEqual(decisions);
  });

  it("is nothing when the office cannot say, so the run asks again", async () => {
    const { runDecisions } = await import("./run-state.js");

    const read = await runDecisions(
      api({
        loadRunState: () => Promise.resolve({ ok: false, kind: "transport", message: "down" }),
      }),
      "task-1",
    );

    expect(read).toEqual([]);
  });
});

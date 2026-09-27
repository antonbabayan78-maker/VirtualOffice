/**
 * The RunCheckpointStore contract, as executable tests. Every store runs it, so
 * an in-memory store and a durable one cannot drift on what resuming relies on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { RunCheckpoint, RunCheckpointStore } from "./checkpoint.js";

export interface RunCheckpointStoreFactory {
  create(): Promise<RunCheckpointStore>;
  /** Opens a second store over the same storage: how a restart is simulated. */
  reopen?(store: RunCheckpointStore): Promise<RunCheckpointStore>;
  destroy(store: RunCheckpointStore): Promise<void>;
}

const checkpoint = (overrides: Partial<RunCheckpoint> = {}): RunCheckpoint => ({
  runId: "run-1",
  step: 2,
  messages: [{ role: "user", content: [{ type: "text", text: "Review PR 42." }] }],
  budget: {
    limits: {},
    spend: {
      inputTokens: 120,
      outputTokens: 40,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 160,
      usd: 0.01,
    },
    turns: 2,
  },
  spendApproved: false,
  droppedMessages: 0,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

export function runCheckpointStoreContract(name: string, factory: RunCheckpointStoreFactory): void {
  describe(`RunCheckpointStore contract: ${name}`, () => {
    let store: RunCheckpointStore;
    beforeEach(async () => {
      store = await factory.create();
    });

    it("has nothing for a run it has never seen", async () => {
      expect(await store.load("unknown")).toBeNull();
      await factory.destroy(store);
    });

    it("saves and reads a checkpoint back unchanged", async () => {
      const saved = checkpoint();
      await store.save(saved);
      expect(await store.load("run-1")).toEqual(saved);
      await factory.destroy(store);
    });

    it("keeps only the newest checkpoint for a run", async () => {
      await store.save(checkpoint({ step: 1 }));
      await store.save(checkpoint({ step: 2 }));
      expect((await store.load("run-1"))?.step).toBe(2);
      await factory.destroy(store);
    });

    it("keeps runs apart", async () => {
      await store.save(checkpoint({ runId: "run-1", step: 1 }));
      await store.save(checkpoint({ runId: "run-2", step: 7 }));
      expect((await store.load("run-1"))?.step).toBe(1);
      expect((await store.load("run-2"))?.step).toBe(7);
      await factory.destroy(store);
    });

    it("round-trips a finished run and a pending approval", async () => {
      const finished = checkpoint({
        finished: { stopReason: "completed", text: "posted", structuredResult: { ok: true } },
      });
      await store.save(finished);
      expect(await store.load("run-1")).toEqual(finished);

      const waiting = checkpoint({
        runId: "run-2",
        pendingApproval: {
          items: [
            { key: "toolu_1", name: "post_message", gates: ["external_send"], detail: "detail" },
          ],
          gates: ["external_send"],
          summary: "approval needed",
        },
      });
      await store.save(waiting);
      expect(await store.load("run-2")).toEqual(waiting);
      await factory.destroy(store);
    });

    it("round-trips a conversation with tool calls and their results", async () => {
      const withTools = checkpoint({
        messages: [
          { role: "user", content: [{ type: "text", text: "Review PR 42." }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_1", name: "get_diff", input: { pr: 42 } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "toolu_1", content: "a diff" }],
          },
        ],
      });
      await store.save(withTools);
      expect(await store.load("run-1")).toEqual(withTools);
      await factory.destroy(store);
    });

    it("forgets a run when it is deleted", async () => {
      await store.save(checkpoint());
      expect(await store.delete("run-1")).toBe(true);
      expect(await store.load("run-1")).toBeNull();
      expect(await store.delete("run-1")).toBe(false);
      await factory.destroy(store);
    });

    if (factory.reopen) {
      it("still has the checkpoint after the process that wrote it is gone", async () => {
        const saved = checkpoint({ step: 4 });
        await store.save(saved);
        const reopened = await factory.reopen?.(store);
        if (!reopened) throw new Error("reopen returned nothing");
        expect(await reopened.load("run-1")).toEqual(saved);
        await factory.destroy(reopened);
      });
    }
  });
}

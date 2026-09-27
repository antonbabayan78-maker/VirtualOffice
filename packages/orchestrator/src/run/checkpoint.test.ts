import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@vo/llm";
import { FsBlobStore } from "@vo/storage";
import {
  BlobRunCheckpointStore,
  InMemoryRunCheckpointStore,
  MAX_CHECKPOINT_BYTES,
  boundCheckpoint,
  checkpointBytes,
  type RunCheckpoint,
} from "./checkpoint.js";
import { runCheckpointStoreContract } from "./checkpoint-contract.js";

runCheckpointStoreContract("in-memory", {
  create: () => Promise.resolve(new InMemoryRunCheckpointStore()),
  destroy: () => Promise.resolve(),
});

const roots: string[] = [];
let currentRoot = "";
runCheckpointStoreContract("blob store on the filesystem", {
  create: () => {
    currentRoot = mkdtempSync(join(tmpdir(), "vo-checkpoints-"));
    roots.push(currentRoot);
    return Promise.resolve(new BlobRunCheckpointStore(new FsBlobStore(currentRoot)));
  },
  // A second store over the same directory is what a restarted worker sees.
  reopen: () => Promise.resolve(new BlobRunCheckpointStore(new FsBlobStore(currentRoot))),
  destroy: () => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    return Promise.resolve();
  },
});

const base = (messages: readonly Message[]): RunCheckpoint => ({
  runId: "run-1",
  step: 1,
  messages,
  budget: {
    limits: {},
    spend: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 0,
      usd: 0,
    },
    turns: 1,
  },
  spendApproved: false,
  droppedMessages: 0,
  updatedAt: 1_700_000_000_000,
});

const chatter = (count: number, size = 200): Message[] =>
  Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: [{ type: "text" as const, text: `${String(i)}:${"x".repeat(size)}` }],
  }));

describe("boundCheckpoint", () => {
  it("leaves a small checkpoint alone", () => {
    const small = base(chatter(3, 10));
    expect(boundCheckpoint(small, MAX_CHECKPOINT_BYTES)).toEqual(small);
  });

  it("drops from the middle until the checkpoint fits, and says how many", () => {
    const big = base(chatter(50, 500));
    const bounded = boundCheckpoint(big, 4_000);
    expect(checkpointBytes(bounded)).toBeLessThanOrEqual(4_000);
    expect(bounded.droppedMessages).toBeGreaterThan(0);
    expect(bounded.messages.length).toBeLessThan(big.messages.length);
  });

  it("keeps the brief and the newest exchanges", () => {
    const big = base(chatter(50, 500));
    const bounded = boundCheckpoint(big, 4_000);
    expect(bounded.messages[0]).toEqual(big.messages[0]);
    expect(bounded.messages.at(-1)).toEqual(big.messages.at(-1));
  });

  it("adds to a count already carried by an earlier trim", () => {
    const already = { ...base(chatter(50, 500)), droppedMessages: 7 };
    expect(boundCheckpoint(already, 4_000).droppedMessages).toBeGreaterThan(7);
  });

  it("never leaves a tool result whose call it dropped", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "brief" }] },
      ...chatter(20, 400),
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_diff", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "toolu_1", content: "x".repeat(400) }],
      },
    ];
    const bounded = boundCheckpoint(base(messages), 2_000);
    const calls = new Set(
      bounded.messages.flatMap((m) =>
        m.content.filter((b) => b.type === "tool_use").map((b) => b.id),
      ),
    );
    for (const message of bounded.messages) {
      for (const block of message.content) {
        if (block.type === "tool_result") expect(calls.has(block.toolUseId)).toBe(true);
      }
    }
  });

  it("gives up rather than dropping the brief when even that will not fit", () => {
    const huge = base([
      { role: "user", content: [{ type: "text", text: "x".repeat(10_000) }] },
      { role: "assistant", content: [{ type: "text", text: "y".repeat(10_000) }] },
    ]);
    const bounded = boundCheckpoint(huge, 500);
    expect(bounded.messages.length).toBeGreaterThanOrEqual(1);
    expect(bounded.messages[0]).toEqual(huge.messages[0]);
  });
});

import { describe, expect, it, vi } from "vitest";
import { estimateTokens, type Message } from "@vo/llm";
import {
  COMPACTION_MARKER,
  ContextCompactor,
  conversationTokens,
  type CompactionContext,
} from "./compaction.js";

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});
const callTool = (id: string, name: string): Message => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input: {} }],
});
const toolResult = (id: string, content: string): Message => ({
  role: "user",
  content: [{ type: "tool_result", toolUseId: id, content }],
});

const filler = (i: number): string => `Turn ${String(i)}: ${"detail ".repeat(60)}`;

function longConversation(turns: number): Message[] {
  const messages: Message[] = [user("Task brief: migrate the billing service to the new schema.")];
  for (let i = 0; i < turns; i++) {
    messages.push(assistant(filler(i)), user(`Reply ${String(i)}: ${"context ".repeat(40)}`));
  }
  return messages;
}

const summarize = vi.fn((_dropped: readonly Message[], _context: CompactionContext) =>
  Promise.resolve("Earlier work: explored the schema and drafted a migration plan."),
);

function compactor(
  overrides: Partial<ConstructorParameters<typeof ContextCompactor>[0]> = {},
): ContextCompactor {
  return new ContextCompactor({
    contextWindow: 4_000,
    reserveOutputTokens: 500,
    summarize,
    policy: { triggerAtFraction: 0.6, keepRecentTurns: 4 },
    ...overrides,
  });
}

describe("conversationTokens", () => {
  it("sums estimated tokens over every block", () => {
    const messages = [user("hello"), assistant("world"), toolResult("t1", "result text")];
    expect(conversationTokens(messages)).toBe(
      estimateTokens("hello") + estimateTokens("world") + estimateTokens("result text"),
    );
  });
});

describe("ContextCompactor", () => {
  it("does not compact a short conversation", async () => {
    const c = compactor();
    const messages = [user("brief"), assistant("ok")];
    expect(c.needsCompaction(messages)).toBe(false);
    const result = await c.compact(messages);
    expect(result).toMatchObject({ compacted: false, reason: "below_threshold" });
    expect(result.messages).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("compacts once the conversation crosses the trigger fraction of usable context", async () => {
    const c = compactor();
    const messages = longConversation(20);
    expect(c.needsCompaction(messages)).toBe(true);
    const result = await c.compact(messages);
    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.droppedMessages).toBeGreaterThan(0);
    expect(c.needsCompaction(result.messages)).toBe(false);
  });

  it("keeps the task brief and the most recent turns byte-identical", async () => {
    const c = compactor();
    const messages = longConversation(20);
    const result = await c.compact(messages);
    expect(result.messages[0]).toEqual(messages[0]);
    expect(result.messages.slice(-4)).toEqual(messages.slice(-4));
  });

  it("inserts the summary as a marked message right after the brief", async () => {
    const c = compactor();
    const result = await c.compact(longConversation(20));
    const summaryMessage = result.messages[1];
    expect(summaryMessage?.role).toBe("user");
    const block = summaryMessage?.content[0];
    expect(block?.type).toBe("text");
    expect(block?.type === "text" ? block.text : "").toContain(COMPACTION_MARKER);
    expect(block?.type === "text" ? block.text : "").toContain("Earlier work:");
    expect(result.summary).toBe("Earlier work: explored the schema and drafted a migration plan.");
  });

  it("passes only the dropped messages to the summarizer", async () => {
    summarize.mockClear();
    const c = compactor();
    const messages = longConversation(20);
    const result = await c.compact(messages);
    expect(summarize).toHaveBeenCalledTimes(1);
    const dropped = summarize.mock.calls[0]?.[0] ?? [];
    expect(dropped).toHaveLength(result.droppedMessages);
    expect(dropped).not.toContain(messages[0]);
    for (const recent of messages.slice(-4)) expect(dropped).not.toContain(recent);
  });

  it("never separates a tool_use from its tool_result", async () => {
    const c = compactor({ policy: { triggerAtFraction: 0.1, keepRecentTurns: 1 } });
    const messages: Message[] = [
      user("Task brief."),
      ...Array.from({ length: 8 }, (_, i) => assistant(filler(i))),
      callTool("toolu_9", "get_diff"),
      toolResult("toolu_9", "diff body ".repeat(50)),
    ];
    const result = await c.compact(messages);
    const kept = result.messages;
    const keptResultIds = kept.flatMap((m) =>
      m.content.filter((b) => b.type === "tool_result").map((b) => b.toolUseId),
    );
    const keptUseIds = new Set(
      kept.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => b.id)),
    );
    expect(keptResultIds).toContain("toolu_9");
    for (const id of keptResultIds) expect(keptUseIds.has(id)).toBe(true);
  });

  it("reports when nothing can be dropped instead of looping", async () => {
    const c = compactor({
      contextWindow: 200,
      reserveOutputTokens: 50,
      policy: { triggerAtFraction: 0.1, keepRecentTurns: 10 },
    });
    const messages = [user("brief ".repeat(50)), assistant("reply ".repeat(50))];
    const result = await c.compact(messages);
    expect(result).toMatchObject({ compacted: false, reason: "nothing_to_drop" });
    expect(result.messages).toEqual(messages);
  });

  it("refuses a summary that would not shrink the conversation", async () => {
    const verbose = vi.fn((_d: readonly Message[], _c: CompactionContext) =>
      Promise.resolve("x".repeat(20_000)),
    );
    const c = compactor({ summarize: verbose });
    const messages = longConversation(20);
    const result = await c.compact(messages);
    expect(result).toMatchObject({ compacted: false, reason: "summary_too_large" });
    expect(result.messages).toEqual(messages);
  });

  it("surfaces a summarizer failure as an uncompacted result rather than throwing", async () => {
    const failing = vi.fn((_d: readonly Message[], _c: CompactionContext) =>
      Promise.reject(new Error("summarizer down")),
    );
    const c = compactor({ summarize: failing });
    const result = await c.compact(longConversation(20));
    expect(result).toMatchObject({ compacted: false, reason: "summarizer_failed" });
    expect(result.error?.message).toContain("summarizer down");
  });

  it("tells the summarizer why it was called and what must survive", async () => {
    summarize.mockClear();
    const c = compactor();
    await c.compact(longConversation(20));
    const context = summarize.mock.calls[0]?.[1];
    expect(context?.reason).toMatch(/context/);
    expect(context?.keptRecentTurns).toBe(4);
    expect(context?.targetTokens).toBeGreaterThan(0);
  });

  it("validates its policy", () => {
    expect(() => compactor({ policy: { triggerAtFraction: 0, keepRecentTurns: 2 } })).toThrow(
      /triggerAtFraction/,
    );
    expect(() => compactor({ policy: { triggerAtFraction: 0.5, keepRecentTurns: 0 } })).toThrow(
      /keepRecentTurns/,
    );
    expect(() => compactor({ contextWindow: 100, reserveOutputTokens: 100 })).toThrow(
      /reserveOutputTokens/,
    );
  });
});

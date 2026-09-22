import { describe, expect, it } from "vitest";
import {
  LlmProviderError,
  type CompletionRequest,
  type CompletionResponse,
} from "../provider/types.js";
import { estimateTokens, FakeLlmProvider, reply, toolCall } from "./fake-provider.js";

const request = (text: string, overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "fake-1",
  system: "You are terse.",
  messages: [{ role: "user", content: [{ type: "text", text }] }],
  ...overrides,
});

describe("FakeLlmProvider", () => {
  it("answers scripted replies in order and records every call", async () => {
    const provider = new FakeLlmProvider({ script: [reply("one"), reply("two")] });
    const a = await provider.complete(request("first"));
    const b = await provider.complete(request("second"));
    expect(a.content).toEqual([{ type: "text", text: "one" }]);
    expect(b.content).toEqual([{ type: "text", text: "two" }]);
    expect(a.stopReason).toBe("end_turn");
    expect(provider.calls.map((c) => c.messages[0]?.content[0])).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("fails loudly when the script is exhausted", async () => {
    const provider = new FakeLlmProvider({ script: [reply("only")] });
    await provider.complete(request("a"));
    await expect(provider.complete(request("b"))).rejects.toThrow(/script exhausted after 1 call/);
  });

  it("supports a handler that inspects the request", async () => {
    const provider = new FakeLlmProvider({
      handler: (req) =>
        req.tools?.some((t) => t.name === "get_diff")
          ? toolCall("get_diff", { pr: 42 })
          : reply("no tools"),
    });
    const plain = await provider.complete(request("x"));
    expect(plain.content).toEqual([{ type: "text", text: "no tools" }]);
    const withTool = await provider.complete(
      request("review", {
        tools: [
          {
            name: "get_diff",
            description: "Fetch a diff",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    expect(withTool.stopReason).toBe("tool_use");
    expect(withTool.content[0]).toMatchObject({
      type: "tool_use",
      name: "get_diff",
      input: { pr: 42 },
    });
    expect((withTool.content[0] as { id: string }).id).toMatch(/^toolu_/);
  });

  it("estimates usage deterministically from the request and response text", async () => {
    const provider = new FakeLlmProvider({ script: [reply("four words of text")] });
    const res = await provider.complete(request("hello there"));
    expect(res.usage).toEqual({
      inputTokens: estimateTokens("You are terse.") + estimateTokens("hello there"),
      outputTokens: estimateTokens("four words of text"),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    const again = new FakeLlmProvider({ script: [reply("four words of text")] });
    expect((await again.complete(request("hello there"))).usage).toEqual(res.usage);
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("honours explicit usage, stop reason and ids on a scripted reply", async () => {
    const custom: Partial<CompletionResponse> = {
      id: "msg_custom",
      stopReason: "max_tokens",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 0,
      },
    };
    const provider = new FakeLlmProvider({ script: [reply("cut off", custom)] });
    const res = await provider.complete(request("x"));
    expect(res).toMatchObject({ id: "msg_custom", stopReason: "max_tokens", model: "fake-1" });
    expect(res.usage.cacheReadInputTokens).toBe(5);
  });

  it("throws configured provider errors with codes and retryability", async () => {
    const provider = new FakeLlmProvider({
      script: [
        new LlmProviderError("rate_limited", "slow down", { status: 429, retryAfterMs: 1000 }),
        reply("ok"),
      ],
    });
    const err = await provider.complete(request("x")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err).toMatchObject({
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfterMs: 1000,
    });
    expect((await provider.complete(request("x"))).content).toEqual([{ type: "text", text: "ok" }]);
    expect(new LlmProviderError("invalid_request", "bad").retryable).toBe(false);
  });

  it("streams text in chunks and ends with the same response complete() would give", async () => {
    const provider = new FakeLlmProvider({
      script: [reply("The quick brown fox jumps over the lazy dog")],
      streamChunkSize: 10,
    });
    const events = [];
    for await (const e of provider.stream(request("x"))) events.push(e);
    const deltas = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("The quick brown fox jumps over the lazy dog");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect((done as { response: CompletionResponse }).response.content).toEqual([
      { type: "text", text: "The quick brown fox jumps over the lazy dog" },
    ]);
  });

  it("streams tool calls as a single event", async () => {
    const provider = new FakeLlmProvider({ script: [toolCall("search", { q: "x" })] });
    const events = [];
    for await (const e of provider.stream(request("x"))) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["tool_use", "done"]);
  });
});

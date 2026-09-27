import { describe, expect, it, vi } from "vitest";
import {
  FakeLlmProvider,
  LlmProviderError,
  reply,
  systemText,
  toolCall,
  type CompletionRequest,
  type ContentBlock,
  type Message,
  type ToolDefinition,
} from "@vo/llm";
import { ContextCompactor } from "./compaction.js";
import { RunBudget } from "./token-budget.js";
import {
  runAgent,
  type AgentRunOptions,
  type ToolOutcome,
  type ToolUse,
} from "./agent-run-loop.js";
import { FIND_TOOL_NAME, LazyToolset } from "../tools/lazy-toolset.js";
import { ToolCatalog, type CatalogTool } from "../tools/tool-catalog.js";

const brief: Message[] = [
  { role: "user", content: [{ type: "text", text: "Review PR 42 and post a summary." }] },
];

const getDiff: ToolDefinition = {
  name: "get_diff",
  description: "Fetch a PR diff",
  inputSchema: { type: "object", properties: { pr: { type: "number" } } },
};
const postMessage: ToolDefinition = {
  name: "post_message",
  description: "Post to Slack",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function options(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    provider: new FakeLlmProvider({ script: [reply("done")] }),
    model: "claude-sonnet-5",
    system: { stable: ["You are Ada, a backend engineer."], dynamic: ["Task: Review PR 42."] },
    messages: brief,
    tools: [getDiff, postMessage],
    executeTool: () => Promise.resolve({ content: "ok" }),
    ...overrides,
  };
}

function requestAt(provider: FakeLlmProvider, index: number): CompletionRequest {
  const request = provider.calls[index];
  if (!request) throw new Error(`no request recorded at index ${String(index)}`);
  return request;
}

const textOf = (message: Message | undefined): string =>
  (message?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");

describe("runAgent", () => {
  it("completes a single-turn run and returns the assistant text", async () => {
    const result = await runAgent(options());
    expect(result.stopReason).toBe("completed");
    expect(result.text).toBe("done");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ index: 0, stopReason: "end_turn", toolCalls: [] });
    expect(result.usage.totalTokens).toBeGreaterThan(0);
    expect(result.messages.at(-1)?.role).toBe("assistant");
  });

  it("sends a cache-aware prompt: sorted tools and a cacheable stable system block", async () => {
    const provider = new FakeLlmProvider({ script: [reply("done")] });
    await runAgent(options({ provider }));
    const request = requestAt(provider, 0);
    expect(request.model).toBe("claude-sonnet-5");
    expect(request.tools?.map((t) => t.name)).toEqual(["get_diff", "post_message"]);
    expect(request.tools?.at(-1)?.cache).toBe(true);
    expect(Array.isArray(request.system)).toBe(true);
    expect(systemText(request.system)).toContain("You are Ada");
    expect(systemText(request.system)).toContain("Task: Review PR 42.");
  });

  it("runs plan, act, observe: executes tool calls and feeds results back in one user message", async () => {
    const executed: string[] = [];
    const provider = new FakeLlmProvider({
      script: [
        {
          content: [
            { type: "tool_use", id: "t1", name: "get_diff", input: { pr: 42 } },
            { type: "tool_use", id: "t2", name: "post_message", input: { text: "hi" } },
          ],
          stopReason: "tool_use",
        },
        reply("summarised"),
      ],
    });
    const result = await runAgent(
      options({
        provider,
        executeTool: (call) => {
          executed.push(call.name);
          return Promise.resolve({ content: `${call.name} result` });
        },
      }),
    );
    expect(result.stopReason).toBe("completed");
    expect(executed).toEqual(["get_diff", "post_message"]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.toolCalls.map((c) => c.name)).toEqual(["get_diff", "post_message"]);

    const observation = result.messages[2];
    expect(observation?.role).toBe("user");
    expect(observation?.content).toHaveLength(2);
    expect(observation?.content.every((b) => b.type === "tool_result")).toBe(true);
    expect(provider.calls[1]?.messages).toHaveLength(3);
  });

  it("returns a tool failure to the model as an error result and keeps going", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("get_diff", { pr: 1 }), reply("recovered")],
    });
    const result = await runAgent(
      options({ provider, executeTool: () => Promise.resolve({ content: "boom", isError: true }) }),
    );
    expect(result.stopReason).toBe("completed");
    const observation = result.messages[2]?.content[0];
    expect(observation).toMatchObject({ type: "tool_result", content: "boom", isError: true });
  });

  it("surfaces a thrown tool executor as an error result rather than failing the run", async () => {
    const provider = new FakeLlmProvider({
      script: [toolCall("get_diff", { pr: 1 }), reply("ok")],
    });
    const result = await runAgent(
      options({ provider, executeTool: () => Promise.reject(new Error("connector down")) }),
    );
    expect(result.stopReason).toBe("completed");
    const block = result.messages[2]?.content[0];
    expect(block?.type === "tool_result" ? block.isError : false).toBe(true);
    expect(block?.type === "tool_result" ? block.content : "").toContain("connector down");
  });

  it("enforces the step limit", async () => {
    const provider = new FakeLlmProvider({ handler: (_r, i) => toolCall("get_diff", { pr: i }) });
    const result = await runAgent(options({ provider, maxSteps: 3 }));
    expect(result.stopReason).toBe("step_limit");
    expect(result.steps).toHaveLength(3);
    expect(provider.calls).toHaveLength(3);
  });

  it("detects a loop of identical tool calls before burning the step limit", async () => {
    const provider = new FakeLlmProvider({ handler: () => toolCall("get_diff", { pr: 42 }) });
    const result = await runAgent(options({ provider, maxSteps: 20, loopThreshold: 3 }));
    expect(result.stopReason).toBe("loop_detected");
    expect(result.steps).toHaveLength(3);
    expect(result.loopSignature).toContain("get_diff");
  });

  it("does not call a loop on different inputs to the same tool", async () => {
    const provider = new FakeLlmProvider({
      handler: (_r, i) => (i < 4 ? toolCall("get_diff", { pr: i }) : reply("varied")),
    });
    const result = await runAgent(options({ provider, maxSteps: 20, loopThreshold: 3 }));
    expect(result.stopReason).toBe("completed");
    expect(result.loopSignature).toBeUndefined();
  });

  it("stops when the run budget is exhausted and records the spend", async () => {
    const provider = new FakeLlmProvider({
      handler: () => toolCall("get_diff", { pr: Math.random() }),
    });
    const budget = new RunBudget({ maxTotalTokens: 120 });
    const result = await runAgent(options({ provider, budget, maxSteps: 20 }));
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.usage.totalTokens).toBeGreaterThanOrEqual(120);
    expect(result.steps.length).toBeLessThan(20);
  });

  it("refuses to start when the budget is already exhausted", async () => {
    const provider = new FakeLlmProvider({ script: [reply("should not run")] });
    const budget = new RunBudget({ maxTotalTokens: 10 });
    budget.record({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    const result = await runAgent(options({ provider, budget }));
    expect(result.stopReason).toBe("budget_exhausted");
    expect(result.steps).toEqual([]);
    expect(provider.calls).toEqual([]);
  });

  it("compacts the conversation when it grows and counts the compactions", async () => {
    const summarize = vi.fn(() => Promise.resolve("Earlier: fetched several diffs."));
    const compactor = new ContextCompactor({
      contextWindow: 800,
      reserveOutputTokens: 100,
      summarize,
      policy: { triggerAtFraction: 0.5, keepRecentTurns: 2 },
    });
    const provider = new FakeLlmProvider({
      handler: (_r, i) => (i < 6 ? toolCall("get_diff", { pr: i }) : reply("finished")),
    });
    const result = await runAgent(
      options({
        provider,
        compactor,
        maxSteps: 20,
        executeTool: () => Promise.resolve({ content: "diff body ".repeat(30) }),
      }),
    );
    expect(result.stopReason).toBe("completed");
    expect(result.compactions).toBeGreaterThan(0);
    expect(summarize).toHaveBeenCalled();
    const lastRequest = requestAt(provider, provider.calls.length - 1);
    expect(textOf(lastRequest.messages[0])).toContain("Review PR 42");
  });

  it("handles find_tool internally through the lazy toolset and never passes it to the executor", async () => {
    const catalogTools: CatalogTool[] = [
      { ...getDiff, connectorId: "github", tags: ["pr"] },
      { ...postMessage, connectorId: "slack", tags: ["chat"] },
    ];
    const toolset = new LazyToolset(new ToolCatalog(catalogTools));
    const executeTool = vi.fn((_call: ToolUse) => Promise.resolve<ToolOutcome>({ content: "ok" }));
    const provider = new FakeLlmProvider({
      script: [
        {
          content: [
            { type: "tool_use", id: "f1", name: FIND_TOOL_NAME, input: { query: "pr diff" } },
          ],
          stopReason: "tool_use",
        },
        toolCall("get_diff", { pr: 42 }),
        reply("done"),
      ],
    });
    const { tools: _unused, ...withoutTools } = options({ provider, toolset, executeTool });
    const result = await runAgent(withoutTools);
    expect(result.stopReason).toBe("completed");
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0]?.[0]?.name).toBe("get_diff");
    expect(provider.calls[0]?.tools?.map((t) => t.name)).toEqual([FIND_TOOL_NAME]);
    expect(provider.calls[1]?.tools?.map((t) => t.name)).toContain("get_diff");
    expect(systemText(provider.calls[0]?.system)).toContain("get_diff (github)");
  });

  it("finishes with a structured result when the model calls the result tool", async () => {
    const resultTool: ToolDefinition = {
      name: "submit_review",
      description: "Submit the finished review",
      inputSchema: {
        type: "object",
        properties: { verdict: { type: "string" }, comments: { type: "number" } },
        required: ["verdict"],
      },
    };
    const provider = new FakeLlmProvider({
      script: [
        {
          content: [
            {
              type: "tool_use",
              id: "r1",
              name: "submit_review",
              input: { verdict: "approve", comments: 2 },
            },
          ],
          stopReason: "tool_use",
        },
      ],
    });
    const executeTool = vi.fn((_call: ToolUse) =>
      Promise.resolve<ToolOutcome>({ content: "unused" }),
    );
    const result = await runAgent(options({ provider, resultTool, executeTool }));
    expect(result.stopReason).toBe("completed");
    expect(result.structuredResult).toEqual({ verdict: "approve", comments: 2 });
    expect(executeTool).not.toHaveBeenCalled();
    expect(provider.calls[0]?.tools?.map((t) => t.name)).toContain("submit_review");
  });

  it("stops on a provider error without throwing", async () => {
    const provider = new FakeLlmProvider({
      script: [new LlmProviderError("auth", "bad key", { status: 401 })],
    });
    const result = await runAgent(options({ provider }));
    expect(result.stopReason).toBe("provider_error");
    expect(result.error).toBeInstanceOf(LlmProviderError);
    expect(result.error?.message).toContain("bad key");
  });

  it("stops when the abort signal fires", async () => {
    const controller = new AbortController();
    const provider = new FakeLlmProvider({
      handler: (_r, i) => {
        if (i === 1) controller.abort();
        return toolCall("get_diff", { pr: i });
      },
    });
    const result = await runAgent(options({ provider, maxSteps: 10, signal: controller.signal }));
    expect(result.stopReason).toBe("aborted");
    expect(result.steps.length).toBeLessThanOrEqual(2);
  });

  it("rejects an empty conversation or one that does not start with a user message", async () => {
    await expect(runAgent(options({ messages: [] }))).rejects.toThrow(/at least one user message/);
    const assistantFirst: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    await expect(runAgent(options({ messages: assistantFirst }))).rejects.toThrow(
      /must start with a user message/,
    );
  });

  it("passes the per-turn output cap through to the provider", async () => {
    const provider = new FakeLlmProvider({ script: [reply("done")] });
    await runAgent(options({ provider, maxOutputTokens: 2_048 }));
    expect(provider.calls[0]?.maxOutputTokens).toBe(2_048);
  });

  it("carries a stable prompt prefix across turns so the cache can hit", async () => {
    const prefixes: string[] = [];
    const provider = new FakeLlmProvider({
      handler: (request, i) => {
        const blocks = typeof request.system === "string" ? [] : (request.system ?? []);
        prefixes.push(
          blocks
            .filter((b) => b.cache)
            .map((b) => b.text)
            .join("|"),
        );
        return i === 0 ? toolCall("get_diff", { pr: 1 }) : reply("done");
      },
    });
    await runAgent(options({ provider }));
    expect(prefixes).toHaveLength(2);
    expect(prefixes[0]).toBe(prefixes[1]);
  });
});

describe("tool result batching", () => {
  it("keeps tool_use and tool_result ids paired", async () => {
    const provider = new FakeLlmProvider({
      script: [
        {
          content: [
            { type: "tool_use", id: "a", name: "get_diff", input: {} },
            { type: "tool_use", id: "b", name: "post_message", input: {} },
          ],
          stopReason: "tool_use",
        },
        reply("done"),
      ],
    });
    const result = await runAgent(options({ provider }));
    const uses = result.messages
      .flatMap((m) =>
        m.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
        ),
      )
      .map((b) => b.id);
    const results = result.messages
      .flatMap((m) =>
        m.content.filter(
          (b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result",
        ),
      )
      .map((b) => b.toolUseId);
    expect(uses).toEqual(["a", "b"]);
    expect(results).toEqual(["a", "b"]);
  });
});

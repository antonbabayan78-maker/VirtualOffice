import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { LlmProviderError, type CompletionRequest, type StreamEvent } from "../provider/types.js";
import {
  AnthropicProvider,
  createAnthropicProvider,
  mapAnthropicError,
  toAnthropicParams,
  type AnthropicClientLike,
} from "./anthropic-provider.js";

// ---------------------------------------------------------------------------
// Fixtures: recorded Messages API shapes
// ---------------------------------------------------------------------------

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_01",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content: [{ type: "text", text: "Hello from Claude", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 4,
    } as Anthropic.Usage,
    ...overrides,
  } as Anthropic.Message;
}

const toolUseMessage = message({
  content: [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Let me check.", citations: null },
    { type: "tool_use", id: "toolu_01", name: "get_diff", input: { pr: 42 } },
  ] as Anthropic.ContentBlock[],
  stop_reason: "tool_use",
});

interface FakeClientOptions {
  create?: (
    params: Anthropic.MessageCreateParamsNonStreaming,
  ) => Anthropic.Message | Promise<Anthropic.Message>;
  streamEvents?: Anthropic.MessageStreamEvent[];
  finalMessage?: Anthropic.Message;
}

function fakeClient(
  options: FakeClientOptions,
): AnthropicClientLike & { params: Anthropic.MessageCreateParams[] } {
  const params: Anthropic.MessageCreateParams[] = [];
  return {
    params,
    messages: {
      create: (p) => {
        params.push(p);
        const fn = options.create ?? (() => message());
        return Promise.resolve(fn(p));
      },
      stream: (p) => {
        params.push(p);
        const events = options.streamEvents ?? [];
        const final = options.finalMessage ?? message();
        return Object.assign(
          (async function* () {
            for (const e of events) yield await Promise.resolve(e);
          })(),
          { finalMessage: () => Promise.resolve(final) },
        );
      },
    },
  };
}

const request: CompletionRequest = {
  model: "claude-opus-5",
  system: "You are terse.",
  messages: [
    { role: "user", content: [{ type: "text", text: "Review PR 42" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_00", name: "get_diff", input: { pr: 42 } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", toolUseId: "toolu_00", content: "diff --git ...", isError: false },
      ],
    },
  ],
  tools: [
    {
      name: "get_diff",
      description: "Fetch a PR diff",
      inputSchema: { type: "object", properties: { pr: { type: "number" } }, required: ["pr"] },
    },
  ],
  temperature: 0.3,
  metadata: { taskId: "t1" },
};

describe("toAnthropicParams", () => {
  it("maps model, system, messages, tool results and tools; defaults max_tokens; omits sampling by default", () => {
    const params = toAnthropicParams(request, {});
    expect(params.model).toBe("claude-opus-5");
    expect(params.max_tokens).toBe(16_000);
    expect(params.system).toBe("You are terse.");
    expect(params.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Review PR 42" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_00", name: "get_diff", input: { pr: 42 } }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_00",
            content: "diff --git ...",
            is_error: false,
          },
        ],
      },
    ]);
    expect(params.tools).toEqual([
      {
        name: "get_diff",
        description: "Fetch a PR diff",
        input_schema: request.tools?.[0]?.inputSchema,
      },
    ]);
    expect("temperature" in params).toBe(false);
    expect("metadata" in params).toBe(false);
  });

  it("honours maxOutputTokens, never sends sampling parameters, and omits an absent system prompt", () => {
    expect(toAnthropicParams({ ...request, maxOutputTokens: 512 }, {}).max_tokens).toBe(512);
    expect("temperature" in toAnthropicParams({ ...request, temperature: 0.9 }, {})).toBe(false);
    const { system: _system, ...withoutSystem } = request;
    expect("system" in toAnthropicParams(withoutSystem, {})).toBe(false);
  });
});

describe("AnthropicProvider.complete", () => {
  it("maps a text response including cached input tokens", async () => {
    const client = fakeClient({ create: () => message() });
    const provider = new AnthropicProvider(client);
    const res = await provider.complete(request);
    expect(provider.id).toBe("anthropic");
    expect(res).toEqual({
      id: "msg_01",
      model: "claude-opus-5",
      content: [{ type: "text", text: "Hello from Claude" }],
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        cacheReadInputTokens: 8,
        cacheCreationInputTokens: 4,
      },
    });
  });

  it("treats null cache counters as zero", async () => {
    const client = fakeClient({
      create: () =>
        message({
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          } as Anthropic.Usage,
        }),
    });
    const res = await new AnthropicProvider(client).complete(request);
    expect(res.usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it("maps tool calls and drops thinking blocks", async () => {
    const res = await new AnthropicProvider(fakeClient({ create: () => toolUseMessage })).complete(
      request,
    );
    expect(res.stopReason).toBe("tool_use");
    expect(res.content).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_01", name: "get_diff", input: { pr: 42 } },
    ]);
  });

  it("passes every stop reason through, including refusal and context window exceeded", async () => {
    for (const stop of [
      "refusal",
      "max_tokens",
      "pause_turn",
      "stop_sequence",
      "model_context_window_exceeded",
    ] as const) {
      const res = await new AnthropicProvider(
        fakeClient({ create: () => message({ stop_reason: stop }) }),
      ).complete(request);
      expect(res.stopReason).toBe(stop);
    }
  });

  it("wraps SDK errors as LlmProviderError", async () => {
    const client = fakeClient({
      create: () => {
        throw Anthropic.APIError.generate(
          429,
          { error: { type: "rate_limit_error", message: "slow down" } },
          "slow down",
          new Headers({ "retry-after": "7" }),
        );
      },
    });
    const err = await new AnthropicProvider(client).complete(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err).toMatchObject({
      code: "rate_limited",
      retryable: true,
      status: 429,
      retryAfterMs: 7000,
    });
  });
});

describe("mapAnthropicError", () => {
  const gen = (
    status: number,
    type: string,
    headers?: Headers,
  ): InstanceType<typeof Anthropic.APIError> =>
    Anthropic.APIError.generate(
      status,
      { error: { type, message: `${type} happened` } },
      `${type} happened`,
      headers ?? new Headers(),
    );

  it("classifies every status family", () => {
    expect(mapAnthropicError(gen(400, "invalid_request_error"))).toMatchObject({
      code: "invalid_request",
      retryable: false,
      status: 400,
    });
    expect(mapAnthropicError(gen(401, "authentication_error"))).toMatchObject({
      code: "auth",
      status: 401,
    });
    expect(mapAnthropicError(gen(402, "billing_error"))).toMatchObject({
      code: "auth",
      status: 402,
    });
    expect(mapAnthropicError(gen(403, "permission_error"))).toMatchObject({ code: "auth" });
    expect(mapAnthropicError(gen(404, "not_found_error"))).toMatchObject({
      code: "invalid_request",
    });
    expect(mapAnthropicError(gen(422, "invalid_request_error"))).toMatchObject({
      code: "invalid_request",
    });
    expect(mapAnthropicError(gen(429, "rate_limit_error"))).toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
    expect(mapAnthropicError(gen(500, "api_error"))).toMatchObject({
      code: "unavailable",
      retryable: true,
      status: 500,
    });
    expect(mapAnthropicError(gen(529, "overloaded_error"))).toMatchObject({
      code: "unavailable",
      retryable: true,
      status: 529,
    });
  });

  it("maps connection and timeout errors, and keeps the original message", () => {
    expect(
      mapAnthropicError(new Anthropic.APIConnectionTimeoutError({ message: "took too long" })),
    ).toMatchObject({ code: "timeout", retryable: true });
    expect(
      mapAnthropicError(new Anthropic.APIConnectionError({ message: "socket hang up" })),
    ).toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("socket hang up") as string,
    });
    expect(mapAnthropicError(new Error("something odd"))).toMatchObject({
      code: "unknown",
      retryable: false,
      message: expect.stringContaining("something odd") as string,
    });
    expect(mapAnthropicError("weird")).toMatchObject({ code: "unknown" });
  });

  it("reads retry-after in seconds or as an HTTP date", () => {
    expect(
      mapAnthropicError(gen(429, "rate_limit_error", new Headers({ "retry-after": "2" })))
        .retryAfterMs,
    ).toBe(2000);
    const later = new Date(Date.now() + 30_000).toUTCString();
    const ms =
      mapAnthropicError(gen(429, "rate_limit_error", new Headers({ "retry-after": later })))
        .retryAfterMs ?? 0;
    expect(ms).toBeGreaterThan(20_000);
    expect(ms).toBeLessThanOrEqual(31_000);
    expect(mapAnthropicError(gen(429, "rate_limit_error")).retryAfterMs).toBeUndefined();
  });
});

describe("AnthropicProvider.stream", () => {
  it("yields text deltas, assembles tool calls from JSON deltas, and ends with the mapped final message", async () => {
    const events: Anthropic.MessageStreamEvent[] = [
      {
        type: "message_start",
        message: message({
          content: [],
          usage: { input_tokens: 12, output_tokens: 0 } as Anthropic.Usage,
        }),
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "", citations: null },
      },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Let me " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "check." } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_01",
          name: "get_diff",
          input: {},
        } as Anthropic.ToolUseBlock,
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"pr": ' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: "42}" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null,
          container: null,
          stop_details: null,
        },
        usage: { output_tokens: 9 } as Anthropic.MessageDeltaUsage,
      },
      { type: "message_stop" },
    ];
    const provider = new AnthropicProvider(
      fakeClient({ streamEvents: events, finalMessage: toolUseMessage }),
    );
    const seen: StreamEvent[] = [];
    for await (const e of provider.stream(request)) seen.push(e);
    expect(seen.map((e) => e.type)).toEqual(["text_delta", "text_delta", "tool_use", "done"]);
    expect(seen[2]).toEqual({
      type: "tool_use",
      block: { type: "tool_use", id: "toolu_01", name: "get_diff", input: { pr: 42 } },
    });
    const done = seen[3] as {
      type: "done";
      response: { stopReason: string; usage: { cacheReadInputTokens: number } };
    };
    expect(done.response.stopReason).toBe("tool_use");
    expect(done.response.usage.cacheReadInputTokens).toBe(8);
  });

  it("uses the default max_tokens for streaming and wraps stream errors", async () => {
    const client = fakeClient({});
    const provider = new AnthropicProvider(client);
    for await (const _ of provider.stream(request)) {
      // drain
    }
    expect(client.params[0]?.max_tokens).toBe(64_000);
    const failing: AnthropicClientLike = {
      messages: {
        create: () => Promise.reject(new Error("unused")),
        stream: () => {
          throw Anthropic.APIError.generate(
            529,
            { error: { type: "overloaded_error", message: "busy" } },
            "busy",
            new Headers(),
          );
        },
      },
    };
    const err = await (async () => {
      for await (const _ of new AnthropicProvider(failing).stream(request)) {
        // drain
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect(err).toMatchObject({ code: "unavailable", status: 529 });
  });
});

describe("createAnthropicProvider", () => {
  it("builds a provider over the real SDK client without talking to the network", () => {
    const provider = createAnthropicProvider({ apiKey: "sk-ant-test", maxRetries: 0 });
    expect(provider.id).toBe("anthropic");
    expect(provider).toBeInstanceOf(AnthropicProvider);
  });
});

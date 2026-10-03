import { describe, expect, it } from "vitest";
import { LlmProviderError, type CompletionRequest, type StreamEvent } from "../provider/types.js";
import { openAiCompatibleProvider } from "./openai-compatible.js";

/** What the adapter sent, and what the server said back. */
interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function server(reply: (call: Call) => Response | Promise<Response>): {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetchLike = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return reply(call);
  };
  return { fetch: fetchLike, calls };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const answer = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "chatcmpl-1",
  model: "gpt-5",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Done." } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
  ...overrides,
});

const ask = (overrides: Partial<CompletionRequest> = {}): CompletionRequest => ({
  model: "gpt-5",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  ...overrides,
});

const provider = (
  reply: (call: Call) => Response | Promise<Response>,
  options: Record<string, unknown> = {},
) => {
  const net = server(reply);
  return {
    net,
    it: openAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      fetch: net.fetch,
      ...options,
    }),
  };
};

describe("a service that speaks chat completions", () => {
  it("posts to the service's own address, with the key as a bearer", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(ask());

    expect(net.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(net.calls[0]?.method).toBe("POST");
    expect(net.calls[0]?.headers["authorization"]).toBe("Bearer sk-test");
    expect(net.calls[0]?.headers["content-type"]).toBe("application/json");
  });

  it("sends no key at all when there is none, which is a model on your own machine", async () => {
    const net = server(() => json(answer()));
    const local = openAiCompatibleProvider({
      id: "workshop",
      baseUrl: "http://localhost:11434/v1",
      fetch: net.fetch,
    });

    await local.complete(ask({ model: "qwen3-coder" }));

    expect(net.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("keeps the address the office wrote down, trailing slash or not", async () => {
    const net = server(() => json(answer()));
    const openai = openAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.com/v1/",
      fetch: net.fetch,
    });

    await openai.complete(ask());

    expect(net.calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("carries the model, the system prompt and what was said", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(
      ask({
        system: [
          { text: "You are Ada.", cache: true },
          { text: "Be brief.", cache: false },
        ],
      }),
    );

    expect(net.calls[0]?.body).toMatchObject({
      model: "gpt-5",
      messages: [
        { role: "system", content: "You are Ada.\n\nBe brief." },
        { role: "user", content: "Hello" },
      ],
    });
  });

  it("answers with the text, the stop reason and what it used", async () => {
    const { it: openai } = provider(() =>
      json(
        answer({
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        }),
      ),
    );

    const response = await openai.complete(ask());

    expect(response).toEqual({
      id: "chatcmpl-1",
      model: "gpt-5",
      content: [{ type: "text", text: "Done." }],
      stopReason: "end_turn",
      usage: {
        inputTokens: 12,
        outputTokens: 4,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
  });

  it("counts a cached read once, not twice", async () => {
    // These services report prompt_tokens including what came from the cache,
    // where the office prices the two apart. Passing the figure through would
    // charge the cached tokens at the full input price as well.
    const { it: openai } = provider(() =>
      json(
        answer({
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 800 },
          },
        }),
      ),
    );

    const response = await openai.complete(ask());

    expect(response.usage.inputTokens).toBe(200);
    expect(response.usage.cacheReadInputTokens).toBe(800);
  });

  it("reports nothing cached when the server never mentions it", async () => {
    // A local server sends usage and no details at all, which is not zero
    // tokens — it is no cache.
    const { it: openai } = provider(() => json(answer()));

    const response = await openai.complete(ask());

    expect(response.usage.cacheReadInputTokens).toBe(0);
    expect(response.usage.inputTokens).toBe(12);
  });

  it("takes what it is given when a server sends no usage at all", async () => {
    const { it: openai } = provider(() => json(answer({ usage: undefined })));

    const response = await openai.complete(ask());

    expect(response.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });
});

describe("tools, over a service that calls them functions", () => {
  const tools = [
    {
      name: "read_file",
      description: "Reads a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    },
  ];

  it("offers them as functions, with the schema untouched", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(ask({ tools }));

    expect(net.calls[0]?.body["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "read_file",
          description: "Reads a file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ]);
  });

  it("offers none when there are none, rather than an empty list", async () => {
    // Some servers refuse `tools: []` outright.
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(ask());

    expect(net.calls[0]?.body).not.toHaveProperty("tools");
  });

  it("reads a call back, arguments and all", async () => {
    const { it: openai } = provider(() =>
      json(
        answer({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: '{"path":"README.md"}' },
                  },
                ],
              },
            },
          ],
        }),
      ),
    );

    const response = await openai.complete(ask({ tools }));

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toEqual([
      { type: "tool_use", id: "call_1", name: "read_file", input: { path: "README.md" } },
    ]);
  });

  it("keeps a call whose arguments are not JSON, with nothing in it", async () => {
    // The call happened. Dropping it would leave the turn with an assistant
    // message nothing answers, and the gate with nothing to approve.
    const { it: openai } = provider(() =>
      json(
        answer({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "{" },
                  },
                ],
              },
            },
          ],
        }),
      ),
    );

    const response = await openai.complete(ask({ tools }));

    expect(response.content).toEqual([
      { type: "tool_use", id: "call_1", name: "read_file", input: {} },
    ]);
  });

  it("hands a result back as the message that service expects", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(
      ask({
        tools,
        messages: [
          { role: "user", content: [{ type: "text", text: "Read it" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", toolUseId: "call_1", content: "# Title" }],
          },
        ],
      }),
    );

    expect(net.calls[0]?.body["messages"]).toEqual([
      { role: "user", content: "Read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "# Title" },
    ]);
  });

  it("says a result went wrong in the result itself, since there is no field for it", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(
      ask({
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", toolUseId: "call_1", content: "no such file", isError: true },
            ],
          },
        ],
      }),
    );

    const messages = net.calls[0]?.body["messages"] as { content: string }[];
    expect(messages[0]?.content).toMatch(/error/i);
    expect(messages[0]?.content).toContain("no such file");
  });

  it("keeps text and a call together in one assistant message", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(
      ask({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me look." },
              { type: "tool_use", id: "call_1", name: "read_file", input: {} },
            ],
          },
        ],
      }),
    );

    expect(net.calls[0]?.body["messages"]).toEqual([
      {
        role: "assistant",
        content: "Let me look.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
        ],
      },
    ]);
  });
});

describe("how far the model got", () => {
  const finished = async (finish: string | null, extra: Record<string, unknown> = {}) => {
    const { it: openai } = provider(() =>
      json(
        answer({
          choices: [
            {
              index: 0,
              finish_reason: finish,
              message: { role: "assistant", content: "x", ...extra },
            },
          ],
        }),
      ),
    );
    return (await openai.complete(ask())).stopReason;
  };

  it("maps each reason a service gives to one the office knows", async () => {
    expect(await finished("stop")).toBe("end_turn");
    expect(await finished("length")).toBe("max_tokens");
    expect(await finished("tool_calls")).toBe("tool_use");
    expect(await finished("function_call")).toBe("tool_use");
    expect(await finished("content_filter")).toBe("refusal");
  });

  it("calls a refusal a refusal, whatever the reason says", async () => {
    expect(await finished("stop", { refusal: "I can't help with that." })).toBe("refusal");
  });

  it("takes a reason it has never seen as the end of the turn", async () => {
    expect(await finished("something_new")).toBe("end_turn");
    expect(await finished(null)).toBe("end_turn");
  });

  it("carries a refusal's words, since an empty answer explains nothing", async () => {
    const { it: openai } = provider(() =>
      json(
        answer({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: null, refusal: "I can't help with that." },
            },
          ],
        }),
      ),
    );

    const response = await openai.complete(ask());

    expect(response.content).toEqual([{ type: "text", text: "I can't help with that." }]);
  });
});

describe("how much it may write, and how warm", () => {
  it("asks a local server in the words every one of them knows", async () => {
    const net = server(() => json(answer()));
    const local = openAiCompatibleProvider({
      id: "workshop",
      baseUrl: "http://localhost:11434/v1",
      fetch: net.fetch,
    });

    await local.complete(ask({ maxOutputTokens: 500, temperature: 0.2 }));

    expect(net.calls[0]?.body).toMatchObject({ max_tokens: 500, temperature: 0.2 });
  });

  it("asks OpenAI in the words its newer models insist on", async () => {
    // `max_tokens` is refused outright by the reasoning models, which is most
    // of what anybody would point this at.
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(ask({ maxOutputTokens: 500 }));

    expect(net.calls[0]?.body).toMatchObject({ max_completion_tokens: 500 });
    expect(net.calls[0]?.body).not.toHaveProperty("max_tokens");
  });

  it("lets the office say which, for a gateway that is neither", async () => {
    const { net, it: openai } = provider(() => json(answer()), { maxTokensField: "max_tokens" });

    await openai.complete(ask({ maxOutputTokens: 500 }));

    expect(net.calls[0]?.body).toMatchObject({ max_tokens: 500 });
  });

  it("says nothing about either when the employee said nothing", async () => {
    const { net, it: openai } = provider(() => json(answer()));

    await openai.complete(ask());

    expect(net.calls[0]?.body).not.toHaveProperty("max_completion_tokens");
    expect(net.calls[0]?.body).not.toHaveProperty("temperature");
  });
});

describe("when the service will not answer", () => {
  const failing = async (reply: (call: Call) => Response | Promise<Response>) => {
    const { it: openai } = provider(reply);
    try {
      await openai.complete(ask());
    } catch (error) {
      return error as LlmProviderError;
    }
    throw new Error("expected a refusal");
  };

  it("says to wait, and for how long, when it is too busy", async () => {
    const error = await failing(() =>
      json(
        { error: { message: "Rate limit reached" } },
        { status: 429, headers: { "retry-after": "12" } },
      ),
    );

    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error.code).toBe("rate_limited");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(12_000);
    expect(error.status).toBe(429);
    expect(error.message).toContain("Rate limit reached");
  });

  it("does not retry a key that is wrong", async () => {
    const error = await failing(() =>
      json({ error: { message: "Incorrect API key" } }, { status: 401 }),
    );

    expect(error.code).toBe("auth");
    expect(error.retryable).toBe(false);
  });

  it("retries a service that is down, and not a request that is wrong", async () => {
    expect((await failing(() => json({}, { status: 503 }))).retryable).toBe(true);
    expect((await failing(() => json({}, { status: 400 }))).code).toBe("invalid_request");
  });

  it("treats a machine that cannot be reached as something to try again", async () => {
    // The usual answer from a local server that is not running.
    const error = await failing(() => Promise.reject(new TypeError("fetch failed")));

    expect(error.code).toBe("unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("fetch failed");
  });

  it("calls a timeout a timeout, so a slow local model is waited out and not blamed", async () => {
    const error = await failing(() => {
      const aborted = new Error("The operation was aborted");
      aborted.name = "AbortError";
      return Promise.reject(aborted);
    });

    expect(error.code).toBe("timeout");
    expect(error.retryable).toBe(true);
  });

  it("says plainly when the answer is not what a service should send", async () => {
    const error = await failing(() => new Response("<html>502</html>", { status: 200 }));

    expect(error.code).toBe("unknown");
    expect(error.message).toMatch(/openai/);
  });

  it("says so when a service answers with no choices at all", async () => {
    const error = await failing(() => json(answer({ choices: [] })));

    expect(error.code).toBe("unknown");
  });

  it("names itself in every complaint, since an office may have several", async () => {
    const error = await failing(() => json({ error: { message: "nope" } }, { status: 500 }));

    expect(error.message).toMatch(/^openai:/);
  });
});

describe("streaming, honestly", () => {
  it("asks for the whole answer and then gives it out in pieces", async () => {
    // Nothing in the office consumes a stream yet. A half-written SSE parser
    // would be a worse lie than saying this plainly.
    const { net, it: openai } = provider(
      () =>
        json(
          answer({
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Hello there" },
              },
            ],
          }),
        ),
      { streamChunkSize: 4 },
    );

    const events: StreamEvent[] = [];
    for await (const event of openai.stream(ask())) events.push(event);

    expect(net.calls[0]?.body).not.toHaveProperty("stream");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("passes the service's refusal on rather than ending the stream quietly", async () => {
    const { it: openai } = provider(() => json({ error: { message: "nope" } }, { status: 500 }));

    const run = async (): Promise<void> => {
      for await (const _event of openai.stream(ask())) {
        // drained
      }
    };

    await expect(run()).rejects.toBeInstanceOf(LlmProviderError);
  });
});

describe("what the service offers", () => {
  it("asks it which models it has, which is how a local server gets its list", async () => {
    const { net, it: openai } = provider(() =>
      json({
        object: "list",
        data: [
          { id: "gpt-5", object: "model" },
          { id: "gpt-5-mini", object: "model" },
        ],
      }),
    );

    const models = await openai.models();

    expect(net.calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(net.calls[0]?.method).toBe("GET");
    expect(models).toEqual(["gpt-5", "gpt-5-mini"]);
  });

  it("reads a list an older server sends as names on their own", async () => {
    const { it: openai } = provider(() => json({ data: [{ name: "llama3" }, "qwen3-coder"] }));

    expect(await openai.models()).toEqual(["llama3", "qwen3-coder"]);
  });

  it("complains the same way as any other refusal", async () => {
    const { it: openai } = provider(() => json({}, { status: 404 }));

    await expect(openai.models()).rejects.toBeInstanceOf(LlmProviderError);
  });
});

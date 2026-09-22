/**
 * Anthropic adapter on the official @anthropic-ai/sdk. Maps the provider-neutral
 * request to the Messages API, maps responses (including cached-token usage and
 * every stop reason) back, never sends sampling parameters (current models reject
 * them), assembles tool calls from streamed JSON deltas, and
 * converts SDK errors into LlmProviderError codes with retryability.
 *
 * The client is injected so tests drive the adapter from recorded fixtures.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  LlmProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type LlmErrorCode,
  type LlmProvider,
  type StreamEvent,
} from "../provider/types.js";

/** The slice of the SDK client the adapter uses; the real `Anthropic` instance satisfies it. */
export interface AnthropicClientLike {
  readonly messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    stream(params: Anthropic.MessageCreateParams): AsyncIterable<Anthropic.MessageStreamEvent> & {
      finalMessage(): Promise<Anthropic.Message>;
    };
  };
}

export interface AnthropicProviderOptions {
  /** Default max_tokens for non-streaming requests. */
  readonly defaultMaxTokens?: number;
  /** Default max_tokens for streaming requests (streaming tolerates larger outputs). */
  readonly defaultStreamMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_STREAM_MAX_TOKENS = 64_000;

function toAnthropicBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError ?? false,
      };
  }
}

export function toAnthropicParams(
  request: CompletionRequest,
  options: AnthropicProviderOptions,
  mode: "complete" | "stream" = "complete",
): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: request.model,
    max_tokens:
      request.maxOutputTokens ??
      (mode === "stream"
        ? (options.defaultStreamMaxTokens ?? DEFAULT_STREAM_MAX_TOKENS)
        : (options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS)),
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content.map(toAnthropicBlock),
    })),
  };
  if (typeof request.system === "string") params.system = request.system;
  else if (request.system !== undefined) {
    params.system = request.system.map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
  }
  if (request.tools && request.tools.length > 0) {
    params.tools = request.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(t.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
  }
  return params;
}

function fromAnthropicBlocks(content: readonly Anthropic.ContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of content) {
    if (block.type === "text") out.push({ type: "text", text: block.text });
    else if (block.type === "tool_use")
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      });
    // thinking, redacted_thinking and server-tool blocks are not part of the neutral interface.
  }
  return out;
}

export function fromAnthropicMessage(message: Anthropic.Message): CompletionResponse {
  return {
    id: message.id,
    model: message.model,
    content: fromAnthropicBlocks(message.content),
    stopReason: message.stop_reason ?? "end_turn",
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (raw === null || raw === undefined || raw.length === 0) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function codeForStatus(status: number): LlmErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

export function mapAnthropicError(error: unknown): LlmProviderError {
  if (error instanceof LlmProviderError) return error;
  if (error instanceof Anthropic.APIConnectionTimeoutError)
    return new LlmProviderError("timeout", `anthropic: ${error.message}`);
  if (error instanceof Anthropic.APIConnectionError)
    return new LlmProviderError("unavailable", `anthropic: ${error.message}`);
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const code = status === undefined ? "unknown" : codeForStatus(status);
    const retry = retryAfterMs(error.headers instanceof Headers ? error.headers : undefined);
    return new LlmProviderError(code, `anthropic: ${error.message}`, {
      ...(status === undefined ? {} : { status }),
      ...(retry === undefined ? {} : { retryAfterMs: retry }),
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new LlmProviderError("unknown", `anthropic: ${message}`);
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";

  constructor(
    private readonly client: AnthropicClientLike,
    private readonly options: AnthropicProviderOptions = {},
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const message = await this.client.messages.create(
        toAnthropicParams(request, this.options, "complete"),
      );
      return fromAnthropicMessage(message);
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
    let stream: ReturnType<AnthropicClientLike["messages"]["stream"]>;
    try {
      stream = this.client.messages.stream(toAnthropicParams(request, this.options, "stream"));
    } catch (e) {
      throw mapAnthropicError(e);
    }
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    try {
      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          toolBlocks.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name,
            json: "",
          });
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta")
            yield { type: "text_delta", text: event.delta.text };
          else if (event.delta.type === "input_json_delta") {
            const pending = toolBlocks.get(event.index);
            if (pending) pending.json += event.delta.partial_json;
          }
        } else if (event.type === "content_block_stop") {
          const pending = toolBlocks.get(event.index);
          if (pending) {
            toolBlocks.delete(event.index);
            yield {
              type: "tool_use",
              block: {
                type: "tool_use",
                id: pending.id,
                name: pending.name,
                input: parseToolInput(pending.json),
              },
            };
          }
        }
      }
      yield { type: "done", response: fromAnthropicMessage(await stream.finalMessage()) };
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }
}

function parseToolInput(json: string): Record<string, unknown> {
  if (json.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export interface CreateAnthropicProviderOptions extends AnthropicProviderOptions {
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
}

/** Builds the adapter over a real SDK client. Credentials resolve from the environment when apiKey is omitted. */
export function createAnthropicProvider(
  options: CreateAnthropicProviderOptions = {},
): AnthropicProvider {
  const { apiKey, baseURL, maxRetries, timeoutMs, ...providerOptions } = options;
  const client = new Anthropic({
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(maxRetries === undefined ? {} : { maxRetries }),
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  return new AnthropicProvider(client, providerOptions);
}

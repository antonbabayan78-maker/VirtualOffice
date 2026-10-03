/**
 * One adapter for most of the world.
 *
 * OpenAI, Grok, DeepSeek, Qwen, Mistral, Together, OpenRouter and Groq all
 * speak the same chat-completions shape, and so does every local runner worth
 * having — Ollama, vLLM, llama.cpp, LM Studio. They differ by address, not by
 * protocol, so one adapter and a base url covers them all. A url pointed at
 * `http://10.0.0.12:11434/v1` is a box in the company network with nothing
 * special about it.
 *
 * **A plain POST, no SDK.** The same way the MCP client is written: `fetch` is
 * injected, so every test here drives the adapter without opening a socket, and
 * the office carries no vendor client it would then have to keep current.
 *
 * **Nothing is cleverer than the protocol.** Our content blocks map onto
 * messages and `tool_calls` one for one, and an answer the office cannot read
 * is an error rather than an empty turn.
 */
import {
  LlmProviderError,
  streamFromResponse,
  systemText,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type LlmErrorCode,
  type LlmProvider,
  type StopReason,
  type StreamEvent,
  type ToolDefinition,
  type Usage,
} from "../provider/types.js";

/** Which field says how long the answer may be. */
export type MaxTokensField = "max_tokens" | "max_completion_tokens";

export interface OpenAiCompatibleOptions {
  /** The name the office knows this service by; it appears in every error. */
  readonly id: string;
  /** Where the service is, up to and including `/v1`. */
  readonly baseUrl: string;
  /** Absent for a server that wants none, which is the local case. */
  readonly apiKey?: string;
  /** Injected so a test never opens a socket. */
  readonly fetch?: typeof fetch;
  /**
   * Which field carries the output limit. Left out, OpenAI's own API is asked
   * in `max_completion_tokens` — its reasoning models refuse `max_tokens`
   * outright — and everything else in `max_tokens`, which every local runner
   * and gateway understands.
   */
  readonly maxTokensField?: MaxTokensField;
  /** How long to wait before calling it a timeout. */
  readonly timeoutMs?: number;
  /** Extra headers, for a gateway that wants one (OpenRouter's referer, say). */
  readonly headers?: Readonly<Record<string, string>>;
  /** How much text a `stream()` hands over at a time. */
  readonly streamChunkSize?: number;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_CHUNK = 24;

/** The hosts whose newer models refuse `max_tokens`. */
const WANTS_COMPLETION_TOKENS = ["api.openai.com"];

function maxTokensFieldFor(baseUrl: string, said: MaxTokensField | undefined): MaxTokensField {
  if (said !== undefined) return said;
  try {
    return WANTS_COMPLETION_TOKENS.includes(new URL(baseUrl).hostname)
      ? "max_completion_tokens"
      : "max_tokens";
  } catch {
    return "max_tokens";
  }
}

interface ChatMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id: string;
    readonly type: "function";
    readonly function: { readonly name: string; readonly arguments: string };
  }[];
}

function toolCallsOf(content: readonly ContentBlock[]): ChatMessage["tool_calls"] {
  const calls = content.filter(
    (block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use",
  );
  if (calls.length === 0) return undefined;
  return calls.map((call) => ({
    id: call.id,
    type: "function" as const,
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }));
}

const textOf = (content: readonly ContentBlock[]): string =>
  content
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");

/**
 * Our messages, as this protocol spells them.
 *
 * A tool result is a message of its own here rather than a block inside the
 * user's turn, so one of ours can become several of theirs. The order is kept,
 * which is what matters: a result has to follow the call it answers.
 */
export function toChatMessages(request: CompletionRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = systemText(request.system);
  if (system.length > 0) messages.push({ role: "system", content: system });

  for (const message of request.messages) {
    const results = message.content.filter(
      (block): block is Extract<ContentBlock, { type: "tool_result" }> =>
        block.type === "tool_result",
    );
    const said = textOf(message.content);
    const calls = toolCallsOf(message.content);

    if (said.length > 0 || calls !== undefined) {
      messages.push({
        role: message.role,
        // Null rather than "": a service that sees an empty string on an
        // assistant turn with tool calls may reject the whole request.
        content: said.length > 0 ? said : null,
        ...(calls === undefined ? {} : { tool_calls: calls }),
      });
    }
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_call_id: result.toolUseId,
        // There is no field for a failed result, so it is said in the words:
        // the model otherwise reads a failure as the answer.
        content: result.isError === true ? `Error: ${result.content}` : result.content,
      });
    }
  }
  return messages;
}

function toFunctions(tools: readonly ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function toChatBody(
  request: CompletionRequest,
  maxTokensField: MaxTokensField,
): Record<string, unknown> {
  return {
    model: request.model,
    messages: toChatMessages(request),
    // Omitted rather than empty: some servers refuse `tools: []`.
    ...(request.tools && request.tools.length > 0 ? { tools: toFunctions(request.tools) } : {}),
    ...(request.maxOutputTokens === undefined ? {} : { [maxTokensField]: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "refusal",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // The call still happened. Dropping it would leave the turn with an
    // assistant message nothing answers.
    return {};
  }
}

function blocksOf(message: Record<string, unknown>): ContentBlock[] {
  const out: ContentBlock[] = [];
  const refusal = message["refusal"];
  const content = message["content"];
  if (typeof refusal === "string" && refusal.length > 0) {
    out.push({ type: "text", text: refusal });
  } else if (typeof content === "string" && content.length > 0) {
    out.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    // A few gateways answer with parts rather than a string.
    for (const part of content) {
      if (isRecord(part) && typeof part["text"] === "string") {
        out.push({ type: "text", text: part["text"] });
      }
    }
  }
  for (const call of Array.isArray(message["tool_calls"]) ? message["tool_calls"] : []) {
    if (!isRecord(call)) continue;
    const fn = isRecord(call["function"]) ? call["function"] : {};
    if (typeof fn["name"] !== "string") continue;
    out.push({
      type: "tool_use",
      id: typeof call["id"] === "string" ? call["id"] : fn["name"],
      name: fn["name"],
      input: parseArguments(fn["arguments"]),
    });
  }
  return out;
}

const count = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);

/**
 * What the call used, in the office's terms.
 *
 * These services count cached tokens inside `prompt_tokens`, where Anthropic
 * reports them beside the input and the office prices the two apart. Passing
 * the figure through would charge the cached tokens at the full input price as
 * well, so the cached ones are taken out of it here.
 */
export function usageOf(raw: unknown): Usage {
  const usage = isRecord(raw) ? raw : {};
  const details = isRecord(usage["prompt_tokens_details"]) ? usage["prompt_tokens_details"] : {};
  const cached = count(details["cached_tokens"]);
  const prompt = count(usage["prompt_tokens"]);
  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: count(usage["completion_tokens"]),
    cacheReadInputTokens: cached,
    // No service in this family charges for writing a cache entry, and none
    // reports one: a figure invented here would be a figure in somebody's bill.
    cacheCreationInputTokens: 0,
  };
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null || raw.length === 0) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function codeForStatus(status: number): LlmErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 402 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "unavailable";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

/** What the service said went wrong, or the status on its own. */
function complaintOf(body: unknown, status: number): string {
  if (isRecord(body)) {
    const error = body["error"];
    if (isRecord(error) && typeof error["message"] === "string") return error["message"];
    if (typeof error === "string") return error;
    if (typeof body["message"] === "string") return body["message"];
  }
  return `request failed with status ${String(status)}`;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly maxTokensField: MaxTokensField;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.id = options.id;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.maxTokensField = maxTokensFieldFor(options.baseUrl, options.maxTokensField);
  }

  private failed(
    code: LlmErrorCode,
    message: string,
    detail: { status?: number; retryAfterMs?: number } = {},
  ): LlmProviderError {
    return new LlmProviderError(code, `${this.id}: ${message}`, detail);
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      // No header at all when there is no key: a local server that is handed
      // an empty bearer may refuse the request outright.
      ...(this.options.apiKey === undefined || this.options.apiKey.length === 0
        ? {}
        : { authorization: `Bearer ${this.options.apiKey}` }),
      ...this.options.headers,
    };
  }

  /** One request, with every way it can fail turned into one of ours. */
  private async send(path: string, body?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A machine that is not listening and one that is too slow are both worth
      // trying again; a local model can take minutes over one answer.
      const aborted = error instanceof Error && error.name === "AbortError";
      throw this.failed(aborted ? "timeout" : "unavailable", message);
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch {
      parsed = undefined;
    }

    if (!response.ok) {
      const retry = retryAfterMs(response.headers);
      throw this.failed(codeForStatus(response.status), complaintOf(parsed, response.status), {
        status: response.status,
        ...(retry === undefined ? {} : { retryAfterMs: retry }),
      });
    }
    if (parsed === undefined) {
      // A proxy's error page with a 200 on it, which is a real thing that
      // happens and reads as an empty answer if it is not said out loud.
      throw this.failed(
        "unknown",
        `answered with something that is not JSON: ${text.slice(0, 200)}`,
      );
    }
    return parsed;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = await this.send("/chat/completions", toChatBody(request, this.maxTokensField));
    const answer = isRecord(body) ? body : {};
    const choices = Array.isArray(answer["choices"]) ? answer["choices"] : [];
    const first: unknown = choices[0];
    if (!isRecord(first)) {
      throw this.failed("unknown", "answered with no choices at all");
    }
    const message = isRecord(first["message"]) ? first["message"] : {};
    const finish = first["finish_reason"];
    const refused = typeof message["refusal"] === "string" && message["refusal"].length > 0;
    const stopReason: StopReason = refused
      ? "refusal"
      : ((typeof finish === "string" ? STOP_REASONS[finish] : undefined) ?? "end_turn");

    return {
      id: typeof answer["id"] === "string" ? answer["id"] : "",
      model: typeof answer["model"] === "string" ? answer["model"] : request.model,
      content: blocksOf(message),
      stopReason,
      usage: usageOf(answer["usage"]),
    };
  }

  /**
   * The finished answer, handed over in pieces.
   *
   * Said plainly rather than written as an SSE parser: nothing in the office
   * consumes a stream yet, and a half-written parser would be a worse lie than
   * this is. The same move the fixture recorder makes.
   */
  async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
    const response = await this.complete(request);
    yield* streamFromResponse(response, this.options.streamChunkSize ?? DEFAULT_CHUNK);
  }

  /**
   * What this service says it has.
   *
   * The only way a local server's list is ever known: nobody publishes the
   * models on somebody's own machine.
   */
  async models(): Promise<string[]> {
    const body = await this.send("/models");
    const listed = isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
    const names: string[] = [];
    for (const entry of listed) {
      if (typeof entry === "string") names.push(entry);
      else if (isRecord(entry)) {
        const name = entry["id"] ?? entry["name"];
        if (typeof name === "string" && name.length > 0) names.push(name);
      }
    }
    return names;
  }
}

export function openAiCompatibleProvider(
  options: OpenAiCompatibleOptions,
): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider(options);
}

/**
 * Provider-neutral LLM interface. Shapes mirror the Messages API (roles,
 * content blocks for text / tool use / tool results, JSON-schema tools, stop
 * reasons including refusal, usage with cached-token counts) so real adapters
 * map one-to-one, while staying independent of any single vendor SDK.
 */

export type Role = "user" | "assistant";

export type ContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "tool_result";
      readonly toolUseId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface Message {
  readonly role: Role;
  readonly content: readonly ContentBlock[];
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema for the tool input. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface CompletionRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolDefinition[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  /** Free-form tags for telemetry; never affects the completion. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export type StopReason =
  "end_turn" | "max_tokens" | "tool_use" | "stop_sequence" | "refusal" | "pause_turn";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface CompletionResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason;
  readonly usage: Usage;
}

export type StreamEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "tool_use"; readonly block: Extract<ContentBlock, { type: "tool_use" }> }
  | { readonly type: "done"; readonly response: CompletionResponse };

export interface LlmProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  stream(request: CompletionRequest): AsyncIterable<StreamEvent>;
}

export type LlmErrorCode =
  "rate_limited" | "auth" | "invalid_request" | "unavailable" | "timeout" | "unknown";

const RETRYABLE: ReadonlySet<LlmErrorCode> = new Set(["rate_limited", "unavailable", "timeout"]);

export class LlmProviderError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: LlmErrorCode,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "LlmProviderError";
    this.retryable = RETRYABLE.has(code);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Streams a finished response as events: text deltas per text block, one event per tool call, then done. */
export async function* streamFromResponse(
  response: CompletionResponse,
  chunkSize: number,
): AsyncGenerator<StreamEvent> {
  const size = Math.max(1, chunkSize);
  for (const block of response.content) {
    if (block.type === "text") {
      for (let i = 0; i < block.text.length; i += size)
        yield { type: "text_delta", text: block.text.slice(i, i + size) };
    } else if (block.type === "tool_use") {
      yield { type: "tool_use", block };
    }
  }
  yield await Promise.resolve({ type: "done", response });
}

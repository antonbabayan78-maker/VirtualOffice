/**
 * Fake LLM provider for tests: scripted replies or a request-inspecting handler,
 * deterministic usage estimates, configurable errors, chunked streaming, and a
 * record of every call. No network, ever.
 */
import { estimateTokens } from "../provider/tokens.js";
import {
  LlmProviderError,
  streamFromResponse,
  systemText,
  type CompletionRequest,
  type CompletionResponse,
  type ContentBlock,
  type LlmProvider,
  type StreamEvent,
} from "../provider/types.js";

export { estimateTokens } from "../provider/tokens.js";

export type ScriptedReply = Partial<CompletionResponse> & {
  readonly content: readonly ContentBlock[];
};
export type ScriptStep = ScriptedReply | LlmProviderError;

export function reply(text: string, overrides: Partial<CompletionResponse> = {}): ScriptedReply {
  return { content: [{ type: "text", text }], ...overrides };
}

let toolCounter = 0;
export function toolCall(
  name: string,
  input: Record<string, unknown>,
  overrides: Partial<CompletionResponse> = {},
): ScriptedReply {
  toolCounter += 1;
  return {
    content: [
      { type: "tool_use", id: `toolu_${String(toolCounter).padStart(4, "0")}`, name, input },
    ],
    stopReason: "tool_use",
    ...overrides,
  };
}

export interface FakeLlmProviderOptions {
  readonly script?: readonly ScriptStep[];
  readonly handler?: (request: CompletionRequest, callIndex: number) => ScriptStep;
  readonly streamChunkSize?: number;
  readonly id?: string;
}

function requestTokens(request: CompletionRequest): number {
  const parts: string[] = [systemText(request.system)];
  for (const m of request.messages) {
    for (const block of m.content) {
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "tool_result") parts.push(block.content);
      else parts.push(JSON.stringify(block.input));
    }
  }
  return parts.reduce((n, p) => n + estimateTokens(p), 0);
}

function responseText(content: readonly ContentBlock[]): string {
  return content
    .map((b) =>
      b.type === "text" ? b.text : b.type === "tool_use" ? JSON.stringify(b.input) : b.content,
    )
    .join("\n");
}

export class FakeLlmProvider implements LlmProvider {
  readonly id: string;
  readonly calls: CompletionRequest[] = [];
  private readonly script: readonly ScriptStep[];
  private readonly handler:
    ((request: CompletionRequest, callIndex: number) => ScriptStep) | undefined;
  private readonly chunkSize: number;
  private cursor = 0;

  constructor(options: FakeLlmProviderOptions = {}) {
    this.id = options.id ?? "fake";
    this.script = options.script ?? [];
    this.handler = options.handler;
    this.chunkSize = options.streamChunkSize ?? 16;
  }

  private next(request: CompletionRequest): ScriptStep {
    const index = this.calls.length;
    this.calls.push(structuredClone(request));
    if (this.handler) return this.handler(request, index);
    const step = this.script[this.cursor];
    if (step === undefined) {
      throw new Error(
        `FakeLlmProvider: script exhausted after ${String(this.cursor)} call(s); add more scripted replies`,
      );
    }
    this.cursor += 1;
    return step;
  }

  private build(request: CompletionRequest, step: ScriptedReply): CompletionResponse {
    const usage = step.usage ?? {
      inputTokens: requestTokens(request),
      outputTokens: estimateTokens(responseText(step.content)),
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const hasToolUse = step.content.some((b) => b.type === "tool_use");
    return {
      id: step.id ?? `msg_fake_${String(this.calls.length).padStart(4, "0")}`,
      model: step.model ?? request.model,
      content: step.content,
      stopReason: step.stopReason ?? (hasToolUse ? "tool_use" : "end_turn"),
      usage,
    };
  }

  complete(request: CompletionRequest): Promise<CompletionResponse> {
    try {
      const step = this.next(request);
      if (step instanceof LlmProviderError) return Promise.reject(step);
      return Promise.resolve(this.build(request, step));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async *stream(request: CompletionRequest): AsyncGenerator<StreamEvent> {
    const response = await this.complete(request);
    yield* streamFromResponse(response, this.chunkSize);
  }
}

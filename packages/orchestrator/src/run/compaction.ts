/**
 * Context compaction (plan §6.9). When a run's conversation approaches the
 * model's usable context, the middle of the history is replaced by a summary:
 * the task brief and the most recent messages survive byte-identical, and a
 * tool_use is never separated from its tool_result. Summarization is delegated,
 * so callers can route it to a cheap model.
 */
import { estimateTokens, type Message } from "@vo/llm";

export const COMPACTION_MARKER = "[compacted earlier context]";

export interface CompactionPolicy {
  /** Compact once the conversation reaches this fraction of usable context. */
  readonly triggerAtFraction: number;
  /** Number of most recent messages kept verbatim. */
  readonly keepRecentTurns: number;
  /** Size the summary should aim for, as a fraction of usable context (default 0.3). */
  readonly targetFraction?: number;
}

export interface CompactionContext {
  readonly reason: string;
  readonly keptRecentTurns: number;
  readonly targetTokens: number;
}

export type Summarizer = (
  dropped: readonly Message[],
  context: CompactionContext,
) => Promise<string>;

export interface CompactorOptions {
  readonly contextWindow: number;
  /** Tokens held back for the model's reply. */
  readonly reserveOutputTokens: number;
  readonly summarize: Summarizer;
  readonly policy?: CompactionPolicy;
}

export type CompactionFailure =
  "below_threshold" | "nothing_to_drop" | "summary_too_large" | "summarizer_failed";

export interface CompactionResult {
  readonly compacted: boolean;
  readonly messages: readonly Message[];
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly droppedMessages: number;
  readonly summary?: string;
  readonly reason?: CompactionFailure;
  readonly error?: Error;
}

const DEFAULT_POLICY: CompactionPolicy = {
  triggerAtFraction: 0.6,
  keepRecentTurns: 6,
  targetFraction: 0.3,
};

export function conversationTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") total += estimateTokens(block.text);
      else if (block.type === "tool_result") total += estimateTokens(block.content);
      else total += estimateTokens(JSON.stringify(block.input));
    }
  }
  return total;
}

function toolUseIds(messages: readonly Message[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === "tool_use") ids.add(b.id);
  return ids;
}

function hasOrphanToolResult(tail: readonly Message[]): boolean {
  const produced = toolUseIds(tail);
  for (const m of tail) {
    for (const b of m.content) {
      if (b.type === "tool_result" && !produced.has(b.toolUseId)) return true;
    }
  }
  return false;
}

export class ContextCompactor {
  private readonly policy: CompactionPolicy;
  private readonly usableContext: number;

  constructor(private readonly options: CompactorOptions) {
    this.policy = { ...DEFAULT_POLICY, ...options.policy };
    if (
      !Number.isFinite(this.policy.triggerAtFraction) ||
      this.policy.triggerAtFraction <= 0 ||
      this.policy.triggerAtFraction > 1
    ) {
      throw new Error("triggerAtFraction must be greater than 0 and at most 1");
    }
    if (!Number.isInteger(this.policy.keepRecentTurns) || this.policy.keepRecentTurns < 1) {
      throw new Error("keepRecentTurns must be a positive integer");
    }
    if (options.reserveOutputTokens >= options.contextWindow) {
      throw new Error("reserveOutputTokens must be smaller than contextWindow");
    }
    this.usableContext = options.contextWindow - options.reserveOutputTokens;
  }

  private get triggerTokens(): number {
    return this.usableContext * this.policy.triggerAtFraction;
  }

  needsCompaction(messages: readonly Message[]): boolean {
    return conversationTokens(messages) >= this.triggerTokens;
  }

  async compact(messages: readonly Message[]): Promise<CompactionResult> {
    const tokensBefore = conversationTokens(messages);
    const unchanged = { messages, tokensBefore, tokensAfter: tokensBefore, droppedMessages: 0 };
    if (tokensBefore < this.triggerTokens)
      return { compacted: false, reason: "below_threshold", ...unchanged };

    // The first message is the task brief and always survives.
    const dropStart = 1;
    let dropEnd = Math.max(dropStart, messages.length - this.policy.keepRecentTurns);
    while (dropEnd > dropStart && hasOrphanToolResult(messages.slice(dropEnd))) dropEnd -= 1;

    const dropped = messages.slice(dropStart, dropEnd);
    if (dropped.length === 0) return { compacted: false, reason: "nothing_to_drop", ...unchanged };

    const targetTokens = Math.max(
      1,
      Math.floor(this.usableContext * (this.policy.targetFraction ?? 0.3)),
    );
    const context: CompactionContext = {
      reason: `context window pressure: ${String(tokensBefore)} of ${String(this.usableContext)} usable tokens`,
      keptRecentTurns: this.policy.keepRecentTurns,
      targetTokens,
    };

    let summary: string;
    try {
      summary = await this.options.summarize(dropped, context);
    } catch (e) {
      return {
        compacted: false,
        reason: "summarizer_failed",
        error: e instanceof Error ? e : new Error(String(e)),
        ...unchanged,
      };
    }

    const head = messages[0];
    const summaryMessage: Message = {
      role: "user",
      content: [{ type: "text", text: `${COMPACTION_MARKER}\n${summary}` }],
    };
    const compactedMessages: Message[] = [
      ...(head ? [head] : []),
      summaryMessage,
      ...messages.slice(dropEnd),
    ];
    const tokensAfter = conversationTokens(compactedMessages);
    if (tokensAfter >= tokensBefore)
      return { compacted: false, reason: "summary_too_large", ...unchanged };

    return {
      compacted: true,
      messages: compactedMessages,
      tokensBefore,
      tokensAfter,
      droppedMessages: dropped.length,
      summary,
    };
  }
}

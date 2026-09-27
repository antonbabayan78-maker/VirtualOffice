/**
 * Agent run loop: plan, act, observe.
 *
 * One turn asks the model with a cache-aware prompt, records usage against the
 * run budget, executes any tool calls and feeds every result back in a single
 * user message. The loop ends when the model stops calling tools, calls the
 * terminal result tool, hits the step limit, exhausts the budget, repeats an
 * identical tool call too often (the watchdog's loop signature) or is aborted.
 * Provider failures end the run with a reason rather than throwing, so the
 * caller decides between retry, reassign and escalate.
 */
import { createHash } from "node:crypto";
import {
  buildPrompt,
  type CompletionRequest,
  type ContentBlock,
  type LlmProvider,
  type Message,
  type StopReason,
  type ToolDefinition,
  type Usage,
} from "@vo/llm";
import type { LazyToolset } from "../tools/lazy-toolset.js";
import type { ContextCompactor } from "./compaction.js";
import { RunBudget, type BudgetSpend } from "./token-budget.js";

export type ToolUse = Extract<ContentBlock, { type: "tool_use" }>;
export type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;

export interface ToolOutcome {
  readonly content: string;
  readonly isError?: boolean;
}

export type ToolExecutor = (call: ToolUse) => Promise<ToolOutcome>;

export type RunStopReason =
  "completed" | "step_limit" | "budget_exhausted" | "loop_detected" | "provider_error" | "aborted";

export interface RunStep {
  readonly index: number;
  readonly stopReason: StopReason;
  readonly toolCalls: readonly { readonly id: string; readonly name: string }[];
  readonly usage: Usage;
  readonly compactedBefore: boolean;
}

export interface AgentRunResult {
  readonly stopReason: RunStopReason;
  /** Text of the last assistant turn. */
  readonly text: string;
  /** Input of the terminal result tool, when one was called. */
  readonly structuredResult?: Readonly<Record<string, unknown>>;
  readonly messages: readonly Message[];
  readonly steps: readonly RunStep[];
  readonly usage: BudgetSpend;
  readonly compactions: number;
  /** The repeated call signature, when the run stopped on a loop. */
  readonly loopSignature?: string;
  readonly error?: Error;
}

export interface AgentRunOptions {
  readonly provider: LlmProvider;
  readonly model: string;
  readonly system: { readonly stable: readonly string[]; readonly dynamic?: readonly string[] };
  /** Conversation so far; must start with a user message. */
  readonly messages: readonly Message[];
  /** Static tool list. Ignored when a toolset is given. */
  readonly tools?: readonly ToolDefinition[];
  /** Lazy toolset: only find_tool and loaded tools reach the model. */
  readonly toolset?: LazyToolset;
  readonly executeTool: ToolExecutor;
  /** Calling this tool ends the run with a structured result. */
  readonly resultTool?: ToolDefinition;
  readonly budget?: RunBudget;
  readonly compactor?: ContextCompactor;
  readonly maxSteps?: number;
  /** How many identical tool calls count as a loop (default 3). */
  readonly loopThreshold?: number;
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
}

export const DEFAULT_MAX_STEPS = 12;
export const DEFAULT_LOOP_THRESHOLD = 3;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Identity of a tool call: name plus a hash of its canonical input. */
export function callSignature(call: ToolUse): string {
  return `${call.name}:${createHash("sha1").update(canonical(call.input)).digest("hex").slice(0, 12)}`;
}

function assistantText(content: readonly ContentBlock[]): string {
  return content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const first = options.messages[0];
  if (first === undefined)
    throw new Error("runAgent: the conversation needs at least one user message");
  if (first.role !== "user")
    throw new Error("runAgent: the conversation must start with a user message");

  const maxSteps = Math.max(1, options.maxSteps ?? DEFAULT_MAX_STEPS);
  const loopThreshold = Math.max(2, options.loopThreshold ?? DEFAULT_LOOP_THRESHOLD);
  const budget = options.budget ?? new RunBudget({});
  const signatureCounts = new Map<string, number>();

  let messages: Message[] = [...options.messages];
  const steps: RunStep[] = [];
  let compactions = 0;
  let text = "";

  const finish = (
    stopReason: RunStopReason,
    extra: {
      structuredResult?: Readonly<Record<string, unknown>>;
      loopSignature?: string;
      error?: Error;
    } = {},
  ): AgentRunResult => ({
    stopReason,
    text,
    messages,
    steps,
    usage: budget.spent,
    compactions,
    ...extra,
  });

  for (let index = 0; index < maxSteps; index++) {
    if (options.signal?.aborted === true) return finish("aborted");
    if (budget.state === "exhausted") return finish("budget_exhausted");

    let compactedBefore = false;
    if (options.compactor?.needsCompaction(messages) === true) {
      const compacted = await options.compactor.compact(messages);
      if (compacted.compacted) {
        messages = [...compacted.messages];
        compactions += 1;
        compactedBefore = true;
      }
    }

    const stable = [...options.system.stable];
    if (options.toolset) stable.push(options.toolset.indexText());
    const available: ToolDefinition[] = [
      ...(options.toolset ? options.toolset.loaded() : (options.tools ?? [])),
    ];
    if (options.resultTool) available.push(options.resultTool);

    const prompt = buildPrompt({
      system: { stable, ...(options.system.dynamic ? { dynamic: options.system.dynamic } : {}) },
      tools: available,
      messages,
    });
    const request: CompletionRequest = {
      model: options.model,
      system: prompt.system,
      tools: prompt.tools,
      messages: prompt.messages,
      ...(options.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: options.maxOutputTokens }),
    };

    let response;
    try {
      response = await options.provider.complete(request);
    } catch (e) {
      return finish("provider_error", { error: e instanceof Error ? e : new Error(String(e)) });
    }

    budget.record(response.usage);
    messages = [...messages, { role: "assistant", content: response.content }];
    const turnText = assistantText(response.content);
    if (turnText.length > 0) text = turnText;

    const toolCalls = response.content.filter((b): b is ToolUse => b.type === "tool_use");
    steps.push({
      index,
      stopReason: response.stopReason,
      toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name })),
      usage: response.usage,
      compactedBefore,
    });

    const terminal =
      options.resultTool && toolCalls.find((c) => c.name === options.resultTool?.name);
    if (terminal) return finish("completed", { structuredResult: terminal.input });

    if (toolCalls.length === 0) return finish("completed");

    for (const call of toolCalls) {
      const signature = callSignature(call);
      const seen = (signatureCounts.get(signature) ?? 0) + 1;
      signatureCounts.set(signature, seen);
      if (seen >= loopThreshold) return finish("loop_detected", { loopSignature: signature });
    }

    const results: ToolResult[] = [];
    for (const call of toolCalls) {
      if (options.toolset?.isFindTool(call) === true) {
        results.push(options.toolset.execute(call));
        continue;
      }
      try {
        const outcome = await options.executeTool(call);
        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: outcome.content,
          ...(outcome.isError === undefined ? {} : { isError: outcome.isError }),
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({
          type: "tool_result",
          toolUseId: call.id,
          content: `tool "${call.name}" failed: ${message}`,
          isError: true,
        });
      }
    }
    // Every result for a turn goes back in one user message, as the API requires.
    messages = [...messages, { role: "user", content: results }];
  }

  return finish("step_limit");
}

/**
 * Usage events (plan §7).
 *
 * Every model call and every tool call produces exactly one event, attributed
 * to the employee, department and task it was spent on. That attribution is the
 * whole point: "the office cost $40 today" is not actionable, while "this
 * employee spends 80% of the office's tokens re-reading the same document" is.
 *
 * Cost is computed by the model registry rather than worked out here, so one
 * price list serves the budget, the dashboard and the bill. An event says when
 * its cost is an estimate, because an unknown model must never look free.
 *
 * Cached tokens are kept apart from fresh input, in both the counts and the
 * cost, since the difference between them is what the caching work is for.
 *
 * Metering never fails the work it measures: a sink that is down loses events
 * and reports the error, and the call it was watching goes through regardless.
 */
import { randomUUID } from "node:crypto";
import type { DepartmentId, EmployeeId, OfficeId, TaskId } from "@vo/core";
import type {
  CompletionRequest,
  CompletionResponse,
  LlmProvider,
  ModelRegistry,
  PricedCost,
  StreamEvent,
  Usage,
} from "@vo/llm";

export interface UsageAttribution {
  readonly officeId: OfficeId;
  readonly departmentId?: DepartmentId;
  readonly employeeId?: EmployeeId;
  readonly taskId?: TaskId;
  readonly runId?: string;
}

interface UsageEventBase {
  readonly id: string;
  /** Epoch ms at which the call finished. */
  readonly at: number;
  readonly attribution: UsageAttribution;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface LlmUsageEvent extends UsageEventBase {
  readonly kind: "llm_call";
  readonly provider: string;
  readonly model: string;
  readonly usage: Usage;
  /**
   * Null when the model has no price the registry knows. Null rather than zero
   * so nothing can quietly add an unpriced call to a total and call it free;
   * anything summing costs has to decide what to do about it.
   */
  readonly cost: PricedCost | null;
  readonly pricingError?: string;
  readonly streamed: boolean;
}

export interface ToolUsageEvent extends UsageEventBase {
  readonly kind: "tool_call";
  readonly toolName: string;
}

export type UsageEvent = LlmUsageEvent | ToolUsageEvent;

export interface UsageSink {
  record(event: UsageEvent): Promise<void>;
}

/** The sink for tests and for a single-process office with nothing durable yet. */
export class InMemoryUsageSink implements UsageSink {
  private readonly saved: UsageEvent[] = [];

  get events(): readonly UsageEvent[] {
    return this.saved;
  }

  record(event: UsageEvent): Promise<void> {
    this.saved.push(event);
    return Promise.resolve();
  }

  clear(): void {
    this.saved.length = 0;
  }
}

const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

export interface UsageRecorderOptions {
  readonly sink: UsageSink;
  /**
   * What each model costs. A function where the list changes while the process
   * runs: an office's own services are added, repriced and switched off on the
   * canvas, and a recorder built once with the prices as they were would report
   * every call on a new service as unpriced for the life of the process.
   */
  readonly registry: ModelRegistry | (() => ModelRegistry);
  readonly now?: () => number;
  readonly id?: () => string;
  /** Told when a sink fails, since the failure must not reach the caller. */
  readonly onError?: (error: Error) => void;
}

export interface LlmCallRecord {
  readonly provider: string;
  readonly model: string;
  readonly usage?: Usage;
  readonly attribution: UsageAttribution;
  readonly durationMs: number;
  readonly streamed?: boolean;
  readonly ok?: boolean;
  readonly error?: string;
}

export interface ToolCallRecord {
  readonly toolName: string;
  readonly attribution: UsageAttribution;
  readonly durationMs: number;
  readonly ok?: boolean;
  readonly error?: string;
}

export class UsageRecorder {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: UsageRecorderOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId = options.id ?? (() => randomUUID());
  }

  async recordLlmCall(record: LlmCallRecord): Promise<LlmUsageEvent> {
    const usage = record.usage ?? NO_USAGE;
    const priced = this.priceOf(record, usage);
    const event: LlmUsageEvent = {
      id: this.newId(),
      at: this.now(),
      kind: "llm_call",
      provider: record.provider,
      model: record.model,
      usage,
      cost: priced.cost,
      ...(priced.error === undefined ? {} : { pricingError: priced.error }),
      streamed: record.streamed ?? false,
      attribution: record.attribution,
      durationMs: record.durationMs,
      ok: record.ok ?? true,
      ...(record.error === undefined ? {} : { error: record.error }),
    };
    await this.emit(event);
    return event;
  }

  /**
   * The registry refuses to guess at a model it does not know, which is right
   * for a budget and wrong for a measurement: an unpriced call still happened.
   */
  private priceOf(
    record: LlmCallRecord,
    usage: Usage,
  ): { cost: PricedCost | null; error?: string } {
    try {
      // Prices are keyed by provider and model together, so the ref is built
      // from both rather than from the bare model name a request carries.
      const prices =
        typeof this.options.registry === "function"
          ? this.options.registry()
          : this.options.registry;
      return {
        cost: prices.costOf({ provider: record.provider, model: record.model }, usage),
      };
    } catch (error) {
      return { cost: null, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async recordToolCall(record: ToolCallRecord): Promise<ToolUsageEvent> {
    const event: ToolUsageEvent = {
      id: this.newId(),
      at: this.now(),
      kind: "tool_call",
      toolName: record.toolName,
      attribution: record.attribution,
      durationMs: record.durationMs,
      ok: record.ok ?? true,
      ...(record.error === undefined ? {} : { error: record.error }),
    };
    await this.emit(event);
    return event;
  }

  private async emit(event: UsageEvent): Promise<void> {
    try {
      await this.options.sink.record(event);
    } catch (error) {
      // Losing a measurement is bad; losing the work being measured is worse.
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

export type AttributionSource = UsageAttribution | (() => UsageAttribution);

export interface MeterProviderOptions {
  readonly recorder: UsageRecorder;
  /** A function when one provider serves several employees. */
  readonly attribution: AttributionSource;
  readonly clock?: () => number;
}

function resolve(source: AttributionSource): UsageAttribution {
  return typeof source === "function" ? source() : source;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Wraps a provider so every call it makes is measured exactly once. */
export function meterProvider(provider: LlmProvider, options: MeterProviderOptions): LlmProvider {
  const clock = options.clock ?? (() => Date.now());

  return {
    id: provider.id,

    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const startedAt = clock();
      try {
        const response = await provider.complete(request);
        await options.recorder.recordLlmCall({
          provider: provider.id,
          model: request.model,
          usage: response.usage,
          attribution: resolve(options.attribution),
          durationMs: clock() - startedAt,
        });
        return response;
      } catch (error) {
        await options.recorder.recordLlmCall({
          provider: provider.id,
          model: request.model,
          attribution: resolve(options.attribution),
          durationMs: clock() - startedAt,
          ok: false,
          error: messageOf(error),
        });
        throw error;
      }
    },

    async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
      const startedAt = clock();
      let usage: Usage | undefined;
      let finished = false;
      let failure: string | undefined;
      try {
        for await (const event of provider.stream(request)) {
          if (event.type === "done") {
            usage = event.response.usage;
            finished = true;
          }
          yield event;
        }
      } catch (error) {
        failure = messageOf(error);
        throw error;
      } finally {
        // Runs on a reader that breaks out early too, so the count stays exact.
        await options.recorder.recordLlmCall({
          provider: provider.id,
          model: request.model,
          ...(usage === undefined ? {} : { usage }),
          attribution: resolve(options.attribution),
          durationMs: clock() - startedAt,
          streamed: true,
          ok: finished && failure === undefined,
          ...(failure === undefined
            ? finished
              ? {}
              : { error: "the stream was abandoned before it finished" }
            : { error: failure }),
        });
      }
    },
  };
}

export interface MeterToolOptions {
  readonly toolName: string;
  readonly attribution: UsageAttribution;
  readonly clock?: () => number;
}

/** Runs a tool call, measuring it exactly once whether it works or not. */
export async function meterToolCall<T>(
  recorder: UsageRecorder,
  options: MeterToolOptions,
  run: () => Promise<T>,
): Promise<T> {
  const clock = options.clock ?? (() => Date.now());
  const startedAt = clock();
  try {
    const result = await run();
    await recorder.recordToolCall({
      toolName: options.toolName,
      attribution: options.attribution,
      durationMs: clock() - startedAt,
    });
    return result;
  } catch (error) {
    await recorder.recordToolCall({
      toolName: options.toolName,
      attribution: options.attribution,
      durationMs: clock() - startedAt,
      ok: false,
      error: messageOf(error),
    });
    throw error;
  }
}

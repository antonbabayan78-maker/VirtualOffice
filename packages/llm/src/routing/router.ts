/**
 * Model routing (plan §6.2). Walks an employee's primary model and fallback chain:
 * retryable errors (rate limits, 5xx, timeouts) are retried with backoff and then
 * fall through to the next candidate; auth and invalid-request errors stop
 * immediately because another model will not fix them. A per-provider circuit
 * breaker skips providers that are currently failing. Rules-based tiering picks
 * a model from task hints so routine work lands on cheaper models.
 */
import type { LlmConfig, TaskPriority } from "@vo/core";
import {
  LlmProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type LlmProvider,
  type StreamEvent,
} from "../provider/types.js";
import type { ModelRef } from "../registry/model-registry.js";
import { CircuitBreaker } from "./circuit-breaker.js";

export interface RoutingPolicy {
  readonly primary: ModelRef;
  readonly fallbacks: readonly ModelRef[];
}

export interface RetryPolicy {
  /** Attempts per candidate model, including the first. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Returns a number in [0, 1); added as a fraction of the delay. */
  readonly jitter?: () => number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 20_000,
};

export type AttemptOutcome = "success" | "retry" | "fallback" | "skipped_open_breaker";

export interface Attempt {
  readonly provider: string;
  readonly model: string;
  readonly outcome: AttemptOutcome;
  /** Delay slept after this attempt before the next one. */
  readonly delayMs: number;
  readonly error?: LlmProviderError;
}

export interface RoutedResponse {
  readonly response: CompletionResponse;
  readonly model: ModelRef;
  readonly attempts: readonly Attempt[];
}

export class RoutingExhaustedError extends Error {
  constructor(
    readonly attempts: readonly Attempt[],
    readonly lastError: LlmProviderError,
    candidates: readonly ModelRef[],
  ) {
    super(
      `every model in the chain failed (${candidates.map((c) => `${c.provider}/${c.model}`).join(", ")}); last error: ${lastError.message}`,
    );
    this.name = "RoutingExhaustedError";
  }
}

export interface RouterOptions {
  readonly providers: Readonly<Record<string, LlmProvider>>;
  readonly retry?: Partial<RetryPolicy>;
  readonly breaker?: CircuitBreaker;
  readonly sleep?: (ms: number) => Promise<void>;
}

function toProviderError(e: unknown): LlmProviderError {
  if (e instanceof LlmProviderError) return e;
  return new LlmProviderError("unknown", e instanceof Error ? e.message : String(e));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class Router {
  private readonly retry: RetryPolicy;
  private readonly breaker: CircuitBreaker;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: RouterOptions) {
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.sleep = options.sleep ?? defaultSleep;
  }

  private provider(id: string): LlmProvider {
    const p = this.options.providers[id];
    if (!p) throw new Error(`no provider registered for "${id}"`);
    return p;
  }

  private candidates(policy: RoutingPolicy): ModelRef[] {
    const all = [policy.primary, ...policy.fallbacks];
    for (const c of all) this.provider(c.provider);
    return all;
  }

  private delayFor(error: LlmProviderError, retryIndex: number): number {
    if (error.retryAfterMs !== undefined) return error.retryAfterMs;
    const backoff = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** retryIndex);
    return Math.round(backoff * (1 + (this.retry.jitter?.() ?? Math.random())));
  }

  async complete(
    request: Omit<CompletionRequest, "model">,
    policy: RoutingPolicy,
  ): Promise<RoutedResponse> {
    const candidates = this.candidates(policy);
    const attempts: Attempt[] = [];
    let lastError: LlmProviderError | null = null;

    for (const candidate of candidates) {
      if (!this.breaker.canRequest(candidate.provider)) {
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          outcome: "skipped_open_breaker",
          delayMs: 0,
        });
        continue;
      }
      const provider = this.provider(candidate.provider);
      for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
        try {
          const response = await provider.complete({ ...request, model: candidate.model });
          this.breaker.recordSuccess(candidate.provider);
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            outcome: "success",
            delayMs: 0,
          });
          return { response, model: candidate, attempts };
        } catch (e) {
          const error = toProviderError(e);
          if (!error.retryable) throw error;
          this.breaker.recordFailure(candidate.provider);
          lastError = error;
          const hasRetry = attempt + 1 < this.retry.maxAttempts;
          const delayMs = hasRetry ? this.delayFor(error, attempt) : 0;
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            outcome: hasRetry ? "retry" : "fallback",
            delayMs,
            error,
          });
          if (hasRetry) await this.sleep(delayMs);
        }
      }
    }
    throw new RoutingExhaustedError(
      attempts,
      lastError ?? new LlmProviderError("unavailable", "no candidate could be attempted"),
      candidates,
    );
  }

  /**
   * Streams from the first candidate that starts delivering events. Failures
   * before the first event retry and fall back like complete(); once events
   * have been delivered the error propagates, because the consumer has state.
   */
  async *stream(
    request: Omit<CompletionRequest, "model">,
    policy: RoutingPolicy,
  ): AsyncGenerator<StreamEvent> {
    const candidates = this.candidates(policy);
    const attempts: Attempt[] = [];
    let lastError: LlmProviderError | null = null;

    for (const candidate of candidates) {
      if (!this.breaker.canRequest(candidate.provider)) {
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          outcome: "skipped_open_breaker",
          delayMs: 0,
        });
        continue;
      }
      const provider = this.provider(candidate.provider);
      for (let attempt = 0; attempt < this.retry.maxAttempts; attempt++) {
        let yielded = false;
        try {
          for await (const event of provider.stream({ ...request, model: candidate.model })) {
            yielded = true;
            yield event;
          }
          this.breaker.recordSuccess(candidate.provider);
          return;
        } catch (e) {
          const error = toProviderError(e);
          if (yielded || !error.retryable) throw error;
          this.breaker.recordFailure(candidate.provider);
          lastError = error;
          const hasRetry = attempt + 1 < this.retry.maxAttempts;
          const delayMs = hasRetry ? this.delayFor(error, attempt) : 0;
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            outcome: hasRetry ? "retry" : "fallback",
            delayMs,
            error,
          });
          if (hasRetry) await this.sleep(delayMs);
        }
      }
    }
    throw new RoutingExhaustedError(
      attempts,
      lastError ?? new LlmProviderError("unavailable", "no candidate could be attempted"),
      candidates,
    );
  }
}

// ---------------------------------------------------------------------------
// Rules-based tiering
// ---------------------------------------------------------------------------

export interface TieringRule {
  readonly when: {
    readonly priority?: readonly TaskPriority[];
    /** Matches when the task carries any of these tags. */
    readonly tags?: readonly string[];
    /** Matches when the prompt is at most this many tokens. */
    readonly maxPromptTokens?: number;
  };
  readonly use: ModelRef;
}

export interface TieringHints {
  readonly priority?: TaskPriority;
  readonly tags?: readonly string[];
  readonly promptTokens?: number;
}

/** First matching rule wins; every condition present on a rule must hold. */
export function applyTiering(
  rules: readonly TieringRule[],
  fallback: ModelRef,
  hints: TieringHints,
): ModelRef {
  for (const rule of rules) {
    const w = rule.when;
    if (
      w.priority !== undefined &&
      (hints.priority === undefined || !w.priority.includes(hints.priority))
    )
      continue;
    if (w.tags !== undefined && !(hints.tags ?? []).some((t) => w.tags?.includes(t))) continue;
    if (
      w.maxPromptTokens !== undefined &&
      (hints.promptTokens === undefined || hints.promptTokens > w.maxPromptTokens)
    )
      continue;
    return rule.use;
  }
  return fallback;
}

export function policyFromLlmConfig(config: LlmConfig): RoutingPolicy {
  return {
    primary: { provider: config.provider, model: config.model },
    fallbacks: config.fallbacks.map((f) => ({ provider: f.provider, model: f.model })),
  };
}

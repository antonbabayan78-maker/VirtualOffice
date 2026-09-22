/**
 * Per-provider circuit breaker. After `failureThreshold` retryable failures within
 * `windowMs` the provider is open (skipped) for `cooldownMs`, then half-open: a
 * limited number of trial calls go through; a success closes it, a failure
 * re-opens it. Keeps 80 employees from hammering a provider that is down.
 */
export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly halfOpenMaxCalls: number;
}

export const DEFAULT_BREAKER_OPTIONS: CircuitBreakerOptions = {
  failureThreshold: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
  halfOpenMaxCalls: 1,
};

interface Entry {
  failures: number[];
  openedAt: number | null;
  halfOpenCalls: number;
}

export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: CircuitBreakerOptions = DEFAULT_BREAKER_OPTIONS,
    private readonly clock: () => number = Date.now,
  ) {}

  private entry(provider: string): Entry {
    let e = this.entries.get(provider);
    if (!e) {
      e = { failures: [], openedAt: null, halfOpenCalls: 0 };
      this.entries.set(provider, e);
    }
    return e;
  }

  state(provider: string): BreakerState {
    const e = this.entry(provider);
    if (e.openedAt === null) return "closed";
    return this.clock() - e.openedAt >= this.options.cooldownMs ? "half_open" : "open";
  }

  /** Whether a request may be attempted now. Half-open trial slots are consumed by this call. */
  canRequest(provider: string): boolean {
    const state = this.state(provider);
    if (state === "closed") return true;
    if (state === "open") return false;
    const e = this.entry(provider);
    if (e.halfOpenCalls >= this.options.halfOpenMaxCalls) return false;
    e.halfOpenCalls += 1;
    return true;
  }

  recordSuccess(provider: string): void {
    const e = this.entry(provider);
    e.failures = [];
    e.openedAt = null;
    e.halfOpenCalls = 0;
  }

  recordFailure(provider: string): void {
    const e = this.entry(provider);
    const now = this.clock();
    const state = this.state(provider);
    if (state === "half_open") {
      e.openedAt = now;
      e.halfOpenCalls = 0;
      return;
    }
    if (state === "open") return;
    e.failures = e.failures.filter((t) => now - t < this.options.windowMs);
    e.failures.push(now);
    if (e.failures.length >= this.options.failureThreshold) {
      e.openedAt = now;
      e.halfOpenCalls = 0;
      e.failures = [];
    }
  }
}

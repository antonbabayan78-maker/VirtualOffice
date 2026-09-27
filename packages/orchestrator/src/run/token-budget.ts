/**
 * Per-run token budget (plan §6.9). Accumulates usage across the turns of one
 * agent run, warns at a fraction of the limit so the run loop can start winding
 * down, and hard-stops the run when tokens, output tokens or cost run out.
 * Cost is priced through the model registry, so a cached read costs less than
 * fresh input while still counting as tokens that passed through.
 */
import type { ModelRef, ModelRegistry, Usage } from "@vo/llm";

export type BudgetReason = "tokens" | "output_tokens" | "cost";
export type BudgetState = "ok" | "warn" | "exhausted";

export interface BudgetLimits {
  /** Hard stop on input + output + cached tokens. */
  readonly maxTotalTokens?: number;
  /** Hard stop on generated tokens alone. */
  readonly maxOutputTokens?: number;
  /** Hard stop on estimated spend. Requires a registry. */
  readonly maxUsd?: number;
  /** Fraction of any limit at which the state becomes "warn" (default 0.8). */
  readonly warnAtFraction?: number;
}

export interface BudgetPricing {
  readonly registry: ModelRegistry;
  readonly model: ModelRef | string;
}

export interface BudgetSpend {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly totalTokens: number;
  readonly usd: number;
}

export interface BudgetSnapshot {
  readonly limits: BudgetLimits;
  readonly spend: BudgetSpend;
  readonly turns: number;
}

export type AffordDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: BudgetReason; readonly remaining: number };

export class BudgetExhaustedError extends Error {
  constructor(
    readonly reason: BudgetReason,
    message: string,
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/** Every token that passed through the model: fresh input, output and both cache counters. */
export function totalTokens(usage: Usage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadInputTokens +
    usage.cacheCreationInputTokens
  );
}

const DEFAULT_WARN_FRACTION = 0.8;

function requirePositive(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

export class RunBudget {
  private input = 0;
  private output = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private usd = 0;
  private turnCount = 0;
  private readonly warnAt: number;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly pricing?: BudgetPricing,
  ) {
    requirePositive(limits.maxTotalTokens, "maxTotalTokens");
    requirePositive(limits.maxOutputTokens, "maxOutputTokens");
    requirePositive(limits.maxUsd, "maxUsd");
    const warn = limits.warnAtFraction ?? DEFAULT_WARN_FRACTION;
    if (!Number.isFinite(warn) || warn <= 0 || warn > 1)
      throw new Error("warnAtFraction must be greater than 0 and at most 1");
    this.warnAt = warn;
  }

  static restore(snapshot: BudgetSnapshot, pricing?: BudgetPricing): RunBudget {
    const budget = new RunBudget(snapshot.limits, pricing);
    budget.input = snapshot.spend.inputTokens;
    budget.output = snapshot.spend.outputTokens;
    budget.cacheRead = snapshot.spend.cacheReadInputTokens;
    budget.cacheWrite = snapshot.spend.cacheCreationInputTokens;
    budget.usd = snapshot.spend.usd;
    budget.turnCount = snapshot.turns;
    return budget;
  }

  record(usage: Usage): void {
    this.input += usage.inputTokens;
    this.output += usage.outputTokens;
    this.cacheRead += usage.cacheReadInputTokens;
    this.cacheWrite += usage.cacheCreationInputTokens;
    if (this.pricing) this.usd += this.pricing.registry.costOf(this.pricing.model, usage).totalUsd;
    this.turnCount += 1;
  }

  get turns(): number {
    return this.turnCount;
  }

  get spent(): BudgetSpend {
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      cacheReadInputTokens: this.cacheRead,
      cacheCreationInputTokens: this.cacheWrite,
      totalTokens: this.input + this.output + this.cacheRead + this.cacheWrite,
      usd: this.usd,
    };
  }

  get remaining(): {
    readonly tokens: number | null;
    readonly outputTokens: number | null;
    readonly usd: number | null;
  } {
    const spend = this.spent;
    return {
      tokens:
        this.limits.maxTotalTokens === undefined
          ? null
          : Math.max(0, this.limits.maxTotalTokens - spend.totalTokens),
      outputTokens:
        this.limits.maxOutputTokens === undefined
          ? null
          : Math.max(0, this.limits.maxOutputTokens - spend.outputTokens),
      usd: this.limits.maxUsd === undefined ? null : Math.max(0, this.limits.maxUsd - spend.usd),
    };
  }

  /** The highest fraction of any configured limit that has been consumed; 0 when unlimited. */
  get usedFraction(): number {
    const spend = this.spent;
    const fractions: number[] = [];
    if (this.limits.maxTotalTokens !== undefined)
      fractions.push(spend.totalTokens / this.limits.maxTotalTokens);
    if (this.limits.maxOutputTokens !== undefined)
      fractions.push(spend.outputTokens / this.limits.maxOutputTokens);
    if (this.limits.maxUsd !== undefined) fractions.push(spend.usd / this.limits.maxUsd);
    return fractions.length === 0 ? 0 : Math.max(...fractions);
  }

  private exhaustion(): { reason: BudgetReason; message: string } | null {
    const spend = this.spent;
    if (
      this.limits.maxTotalTokens !== undefined &&
      spend.totalTokens >= this.limits.maxTotalTokens
    ) {
      return {
        reason: "tokens",
        message: `run budget exhausted: ${String(spend.totalTokens)} tokens spent of ${String(this.limits.maxTotalTokens)} allowed`,
      };
    }
    if (
      this.limits.maxOutputTokens !== undefined &&
      spend.outputTokens >= this.limits.maxOutputTokens
    ) {
      return {
        reason: "output_tokens",
        message: `run budget exhausted: ${String(spend.outputTokens)} output tokens generated of ${String(this.limits.maxOutputTokens)} allowed`,
      };
    }
    if (this.limits.maxUsd !== undefined && spend.usd >= this.limits.maxUsd) {
      return {
        reason: "cost",
        message: `run budget exhausted: estimated cost $${spend.usd.toFixed(4)} of $${this.limits.maxUsd.toFixed(4)} allowed`,
      };
    }
    return null;
  }

  get state(): BudgetState {
    if (this.exhaustion() !== null) return "exhausted";
    return this.usedFraction >= this.warnAt ? "warn" : "ok";
  }

  /** Whether a call whose prompt is roughly `estimatedTokens` may still be made. */
  canAfford(estimatedTokens: number): AffordDecision {
    const exhausted = this.exhaustion();
    if (exhausted) {
      const remaining =
        exhausted.reason === "cost" ? (this.remaining.usd ?? 0) : (this.remaining.tokens ?? 0);
      return { allowed: false, reason: exhausted.reason, remaining };
    }
    const max = this.limits.maxTotalTokens;
    if (max !== undefined && this.spent.totalTokens + estimatedTokens > max) {
      return { allowed: false, reason: "tokens", remaining: max - this.spent.totalTokens };
    }
    return { allowed: true };
  }

  assertCanContinue(): void {
    const exhausted = this.exhaustion();
    if (exhausted) throw new BudgetExhaustedError(exhausted.reason, exhausted.message);
  }

  /**
   * Takes on a snapshot's spend, keeping this budget's own limits and pricing.
   * How a resumed run carries what it has already cost.
   */
  adopt(snapshot: BudgetSnapshot): void {
    this.input = snapshot.spend.inputTokens;
    this.output = snapshot.spend.outputTokens;
    this.cacheRead = snapshot.spend.cacheReadInputTokens;
    this.cacheWrite = snapshot.spend.cacheCreationInputTokens;
    this.usd = snapshot.spend.usd;
    this.turnCount = snapshot.turns;
  }

  snapshot(): BudgetSnapshot {
    return { limits: this.limits, spend: this.spent, turns: this.turnCount };
  }
}

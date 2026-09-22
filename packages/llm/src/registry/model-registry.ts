/**
 * Model registry: what each model can do, how much context it takes, and what
 * it costs per million tokens (input, output, cache read, cache write). The
 * router picks models from it and telemetry prices usage with it. Unknown
 * models can be priced with a configured default so a new model never breaks
 * cost tracking; without a default they fail loudly.
 */
import type { Usage } from "../provider/types.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheReadPerMTok: number;
  readonly cacheWritePerMTok: number;
}

export type ModelTier = "frontier" | "balanced" | "fast" | "local";

export interface ModelCapabilities {
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly promptCaching: boolean;
  readonly vision: boolean;
  readonly thinking: boolean;
  readonly batch: boolean;
}

export interface ModelSpec {
  readonly provider: string;
  readonly id: string;
  readonly displayName: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly tier: ModelTier;
  readonly capabilities: ModelCapabilities;
  readonly pricing: ModelPricing;
  readonly aliases?: readonly string[];
  readonly deprecated?: boolean;
}

export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

export interface CostBreakdown {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly cacheReadUsd: number;
  readonly cacheWriteUsd: number;
  readonly totalUsd: number;
}

export interface PricedCost extends CostBreakdown {
  readonly pricingSource: "model" | "default";
}

export interface ModelFilter {
  readonly provider?: string;
  readonly tier?: ModelTier;
  readonly capability?: keyof ModelCapabilities;
  readonly minContextWindow?: number;
  readonly includeDeprecated?: boolean;
}

export class UnknownModelError extends Error {
  constructor(readonly ref: ModelRef) {
    super(`unknown model "${ref.provider}/${ref.model}"; register it or configure a default price`);
    this.name = "UnknownModelError";
  }
}

const PER_MTOK = 1e-6;

export function estimateCost(usage: Usage, pricing: ModelPricing): CostBreakdown {
  const inputUsd = usage.inputTokens * pricing.inputPerMTok * PER_MTOK;
  const outputUsd = usage.outputTokens * pricing.outputPerMTok * PER_MTOK;
  const cacheReadUsd = usage.cacheReadInputTokens * pricing.cacheReadPerMTok * PER_MTOK;
  const cacheWriteUsd = usage.cacheCreationInputTokens * pricing.cacheWritePerMTok * PER_MTOK;
  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd: inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd,
  };
}

export function parseModelRef(ref: string | ModelRef): ModelRef {
  if (typeof ref !== "string") return { provider: ref.provider, model: ref.model };
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new Error(`model reference "${ref}" must look like "provider/model"`);
  }
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

/** Blended price used to rank models: 3 input tokens per output token, a typical agent ratio. */
export function blendedPricePerMTok(pricing: ModelPricing): number {
  return (3 * pricing.inputPerMTok + pricing.outputPerMTok) / 4;
}

export interface ModelRegistryOptions {
  readonly defaultPricing?: ModelPricing;
}

const key = (provider: string, id: string): string =>
  `${provider.toLowerCase()}/${id.toLowerCase()}`;

export class ModelRegistry {
  private readonly specs = new Map<string, ModelSpec>();
  private readonly index = new Map<string, string>();
  private readonly defaultPricing: ModelPricing | undefined;

  constructor(specs: readonly ModelSpec[] = [], options: ModelRegistryOptions = {}) {
    this.defaultPricing = options.defaultPricing;
    for (const spec of specs) this.register(spec);
  }

  register(spec: ModelSpec): this {
    const primary = key(spec.provider, spec.id);
    const names = [spec.id, ...(spec.aliases ?? [])];
    for (const name of names) {
      const k = key(spec.provider, name);
      if (this.index.has(k))
        throw new Error(`duplicate model id or alias "${spec.provider}/${name}"`);
    }
    this.specs.set(primary, spec);
    for (const name of names) this.index.set(key(spec.provider, name), primary);
    return this;
  }

  get(ref: string | ModelRef): ModelSpec | null {
    const r = parseModelRef(ref);
    const primary = this.index.get(key(r.provider, r.model));
    return primary === undefined ? null : (this.specs.get(primary) ?? null);
  }

  has(ref: string | ModelRef): boolean {
    return this.get(ref) !== null;
  }

  require(ref: string | ModelRef): ModelSpec {
    const spec = this.get(ref);
    if (!spec) throw new UnknownModelError(parseModelRef(ref));
    return spec;
  }

  list(filter: ModelFilter = {}): ModelSpec[] {
    return [...this.specs.values()].filter((m) => {
      if (filter.provider !== undefined && m.provider !== filter.provider) return false;
      if (filter.tier !== undefined && m.tier !== filter.tier) return false;
      if (filter.capability !== undefined && !m.capabilities[filter.capability]) return false;
      if (filter.minContextWindow !== undefined && m.contextWindow < filter.minContextWindow)
        return false;
      if (m.deprecated === true && filter.includeDeprecated !== true) return false;
      return true;
    });
  }

  cheapest(filter: ModelFilter = {}): ModelSpec | null {
    const candidates = this.list(filter);
    if (candidates.length === 0) return null;
    return candidates.reduce((best, m) =>
      blendedPricePerMTok(m.pricing) < blendedPricePerMTok(best.pricing) ? m : best,
    );
  }

  /** True when prompt plus reserved output fits the model's context window. */
  fitsContext(ref: string | ModelRef, promptTokens: number, reservedOutputTokens: number): boolean {
    const spec = this.require(ref);
    return (
      promptTokens + Math.min(reservedOutputTokens, spec.maxOutputTokens) <= spec.contextWindow
    );
  }

  costOf(ref: string | ModelRef, usage: Usage): PricedCost {
    const spec = this.get(ref);
    if (spec) return { ...estimateCost(usage, spec.pricing), pricingSource: "model" };
    if (this.defaultPricing)
      return { ...estimateCost(usage, this.defaultPricing), pricingSource: "default" };
    throw new UnknownModelError(parseModelRef(ref));
  }
}

/** A registry pre-loaded with the built-in tables. */
export function defaultModelRegistry(options: ModelRegistryOptions = {}): ModelRegistry {
  return new ModelRegistry(ANTHROPIC_MODELS, options);
}

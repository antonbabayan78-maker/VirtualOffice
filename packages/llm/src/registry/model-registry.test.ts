import { describe, expect, it } from "vitest";
import type { Usage } from "../provider/types.js";
import { ANTHROPIC_MODELS } from "./anthropic-models.js";
import {
  defaultModelRegistry,
  estimateCost,
  ModelRegistry,
  parseModelRef,
  UnknownModelError,
  type ModelPricing,
  type ModelSpec,
} from "./model-registry.js";

const usage: Usage = {
  inputTokens: 1_000,
  outputTokens: 500,
  cacheReadInputTokens: 200,
  cacheCreationInputTokens: 100,
};

const opus5: ModelPricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 6.25,
};

describe("estimateCost", () => {
  it("prices input, output, cache reads and cache writes per million tokens", () => {
    const cost = estimateCost(usage, opus5);
    expect(cost.inputUsd).toBeCloseTo(1_000 * 5e-6, 12);
    expect(cost.outputUsd).toBeCloseTo(500 * 25e-6, 12);
    expect(cost.cacheReadUsd).toBeCloseTo(200 * 0.5e-6, 12);
    expect(cost.cacheWriteUsd).toBeCloseTo(100 * 6.25e-6, 12);
    expect(cost.totalUsd).toBeCloseTo(0.005 + 0.0125 + 0.0001 + 0.000625, 12);
  });

  it("treats cached reads as separate from uncached input", () => {
    const uncached = estimateCost(
      { ...usage, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      opus5,
    );
    const cached = estimateCost({ ...usage, inputTokens: 800 }, opus5);
    expect(cached.totalUsd).toBeLessThan(uncached.totalUsd);
    expect(
      estimateCost(
        { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        opus5,
      ).totalUsd,
    ).toBe(0);
  });
});

describe("parseModelRef", () => {
  it("accepts provider/model strings and ModelRef objects", () => {
    expect(parseModelRef("anthropic/claude-opus-5")).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(parseModelRef({ provider: "openai", model: "gpt-5" })).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(() => parseModelRef("claude-opus-5")).toThrow(/provider\/model/);
    expect(() => parseModelRef("/x")).toThrow(/provider\/model/);
  });
});

describe("built-in Anthropic table", () => {
  it("lists the current generation with sane numbers", () => {
    const ids = ANTHROPIC_MODELS.map((m) => m.id);
    for (const id of [
      "claude-fable-5-1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "claude-opus-4-8",
      "claude-sonnet-4-6",
    ]) {
      expect(ids).toContain(id);
    }
    for (const m of ANTHROPIC_MODELS) {
      expect(m.provider).toBe("anthropic");
      expect(m.pricing.inputPerMTok).toBeGreaterThan(0);
      expect(m.pricing.outputPerMTok).toBeGreaterThan(m.pricing.inputPerMTok);
      expect(m.pricing.cacheReadPerMTok).toBeLessThan(m.pricing.inputPerMTok);
      expect(m.pricing.cacheWritePerMTok).toBeGreaterThanOrEqual(m.pricing.inputPerMTok);
      expect(m.contextWindow).toBeGreaterThan(m.maxOutputTokens);
      expect(m.capabilities.tools).toBe(true);
      expect(m.capabilities.streaming).toBe(true);
    }
    const opus = ANTHROPIC_MODELS.find((m) => m.id === "claude-opus-5");
    if (!opus) throw new Error("claude-opus-5 missing from the table");
    expect(opus.pricing).toEqual(opus5);
    expect(opus.contextWindow).toBe(1_000_000);
    expect(opus.tier).toBe("frontier");
    expect(ANTHROPIC_MODELS.find((m) => m.id === "claude-haiku-4-5")?.tier).toBe("fast");
  });
});

describe("ModelRegistry", () => {
  const custom: ModelSpec = {
    provider: "ollama",
    id: "llama3",
    displayName: "Llama 3 (local)",
    contextWindow: 8_192,
    maxOutputTokens: 4_096,
    tier: "local",
    capabilities: {
      tools: true,
      streaming: true,
      promptCaching: false,
      vision: false,
      thinking: false,
      batch: false,
    },
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    aliases: ["llama3:latest"],
  };

  it("resolves models by provider/id, alias and case-insensitively", () => {
    const registry = new ModelRegistry([...ANTHROPIC_MODELS, custom]);
    expect(registry.get("anthropic/claude-opus-5")?.displayName).toBe("Claude Opus 5");
    expect(registry.get({ provider: "anthropic", model: "CLAUDE-OPUS-5" })?.id).toBe(
      "claude-opus-5",
    );
    expect(registry.get("ollama/llama3:latest")?.id).toBe("llama3");
    expect(registry.get("anthropic/claude-9")).toBeNull();
    expect(registry.has("ollama/llama3")).toBe(true);
    expect(registry.require("anthropic/claude-sonnet-5").tier).toBe("balanced");
    expect(() => registry.require("anthropic/nope")).toThrow(UnknownModelError);
  });

  it("rejects duplicate ids or aliases within a provider", () => {
    expect(() => new ModelRegistry([custom, { ...custom, displayName: "again" }])).toThrow(
      /duplicate/,
    );
    expect(
      () => new ModelRegistry([custom, { ...custom, id: "other", aliases: ["llama3"] }]),
    ).toThrow(/duplicate/);
  });

  it("lists and filters by provider, tier and capability", () => {
    const registry = new ModelRegistry([...ANTHROPIC_MODELS, custom]);
    expect(registry.list().length).toBe(ANTHROPIC_MODELS.length + 1);
    expect(registry.list({ provider: "ollama" }).map((m) => m.id)).toEqual(["llama3"]);
    expect(registry.list({ tier: "fast" }).map((m) => m.id)).toEqual(["claude-haiku-4-5"]);
    expect(
      registry.list({ capability: "promptCaching" }).every((m) => m.capabilities.promptCaching),
    ).toBe(true);
    expect(registry.list({ capability: "vision" }).map((m) => m.provider)).not.toContain("ollama");
    expect(
      registry.list({ minContextWindow: 500_000 }).every((m) => m.contextWindow >= 500_000),
    ).toBe(true);
  });

  it("finds the cheapest model matching a filter by blended price", () => {
    const registry = new ModelRegistry([...ANTHROPIC_MODELS, custom]);
    expect(registry.cheapest({ provider: "anthropic" })?.id).toBe("claude-haiku-4-5");
    expect(
      registry.cheapest({ provider: "anthropic", minContextWindow: 500_000, tier: "frontier" })?.id,
    ).toBe("claude-opus-5");
    expect(registry.cheapest({ provider: "nope" })).toBeNull();
  });

  it("checks whether a prompt fits the context window", () => {
    const registry = new ModelRegistry([...ANTHROPIC_MODELS]);
    expect(registry.fitsContext("anthropic/claude-haiku-4-5", 150_000, 10_000)).toBe(true);
    expect(registry.fitsContext("anthropic/claude-haiku-4-5", 195_000, 10_000)).toBe(false);
    expect(registry.fitsContext("anthropic/claude-opus-5", 900_000, 50_000)).toBe(true);
  });

  it("costs usage for a known model from the table", () => {
    const registry = new ModelRegistry([...ANTHROPIC_MODELS]);
    const cost = registry.costOf("anthropic/claude-opus-5", usage);
    expect(cost.pricingSource).toBe("model");
    expect(cost.totalUsd).toBeCloseTo(estimateCost(usage, opus5).totalUsd, 12);
  });

  it("falls back to the configured default price for an unknown model, or throws without one", () => {
    const fallback: ModelPricing = {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: 3.75,
    };
    const registry = new ModelRegistry([...ANTHROPIC_MODELS], { defaultPricing: fallback });
    const cost = registry.costOf("openrouter/some-new-model", usage);
    expect(cost.pricingSource).toBe("default");
    expect(cost.totalUsd).toBeCloseTo(estimateCost(usage, fallback).totalUsd, 12);
    const strict = new ModelRegistry([...ANTHROPIC_MODELS]);
    expect(() => strict.costOf("openrouter/some-new-model", usage)).toThrow(UnknownModelError);
  });

  it("registers additional models after construction and refuses conflicts", () => {
    const registry = new ModelRegistry([]);
    registry.register(custom);
    expect(registry.has("ollama/llama3")).toBe(true);
    expect(() => registry.register(custom)).toThrow(/duplicate/);
  });

  it("ships a default registry with the Anthropic table", () => {
    expect(defaultModelRegistry().has("anthropic/claude-fable-5-1")).toBe(true);
    expect(defaultModelRegistry({ defaultPricing: opus5 }).costOf("x/y", usage).pricingSource).toBe(
      "default",
    );
  });
});

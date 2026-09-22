/**
 * Anthropic model table. Prices are USD per million tokens at first-party API
 * rates (cache write = 1.25x input for the 5-minute cache; cache read = 0.1x
 * input, except Claude Fable 5.1 at $0.25). Update PRICING_AS_OF when refreshing.
 */
import type { ModelCapabilities, ModelSpec } from "./model-registry.js";

export const PRICING_AS_OF = "2026-06-24";

const FULL: ModelCapabilities = {
  tools: true,
  streaming: true,
  promptCaching: true,
  vision: true,
  thinking: true,
  batch: true,
};

function claude(
  id: string,
  displayName: string,
  tier: ModelSpec["tier"],
  input: number,
  output: number,
  options: { cacheRead?: number; contextWindow?: number; maxOutputTokens?: number } = {},
): ModelSpec {
  return {
    provider: "anthropic",
    id,
    displayName,
    tier,
    contextWindow: options.contextWindow ?? 1_000_000,
    maxOutputTokens: options.maxOutputTokens ?? 128_000,
    capabilities: FULL,
    pricing: {
      inputPerMTok: input,
      outputPerMTok: output,
      cacheReadPerMTok: options.cacheRead ?? input * 0.1,
      cacheWritePerMTok: input * 1.25,
    },
  };
}

export const ANTHROPIC_MODELS: readonly ModelSpec[] = [
  claude("claude-fable-5-1", "Claude Fable 5.1", "frontier", 10, 50, { cacheRead: 0.25 }),
  claude("claude-fable-5", "Claude Fable 5", "frontier", 10, 50),
  claude("claude-opus-5", "Claude Opus 5", "frontier", 5, 25),
  claude("claude-opus-4-8", "Claude Opus 4.8", "frontier", 5, 25),
  claude("claude-opus-4-7", "Claude Opus 4.7", "frontier", 5, 25),
  claude("claude-opus-4-6", "Claude Opus 4.6", "frontier", 5, 25),
  claude("claude-sonnet-5", "Claude Sonnet 5", "balanced", 2, 10),
  claude("claude-sonnet-4-6", "Claude Sonnet 4.6", "balanced", 3, 15),
  claude("claude-haiku-4-5", "Claude Haiku 4.5", "fast", 1, 5, {
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
  }),
];

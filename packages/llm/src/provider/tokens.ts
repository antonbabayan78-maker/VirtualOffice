/** Roughly four characters per token; deterministic, provider-neutral. Real counts come from usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

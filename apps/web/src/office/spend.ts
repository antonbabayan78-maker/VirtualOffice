/**
 * What a set of calls came to.
 *
 * Lived inside the bench record, which is where it was first needed, and is now
 * wanted by the task detail as well — two places adding the same rows up their
 * own way is two figures for one question, and the one that drifts is always
 * the one nobody is looking at.
 *
 * Costs that could not be priced are never folded in silently. The registry
 * answers null for a model it does not know, deliberately, so anything summing
 * has to decide what to do about it: these totals carry the count and say "at
 * least" when they have one.
 */
import type { UsageRecord } from "@vo/core";

export interface Spend {
  readonly usd: number;
  /** Calls the registry had no price for; a total holding one is a floor. */
  readonly unpriced: number;
  readonly ms: number;
  readonly calls: number;
}

export interface Tokens {
  readonly input: number;
  readonly output: number;
  /** Read back from the provider's cache: the cheap half, worth seeing apart. */
  readonly cached: number;
}

const NOTHING: Spend = { usd: 0, unpriced: 0, ms: 0, calls: 0 };
const NO_TOKENS: Tokens = { input: 0, output: 0, cached: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function spendOf(rows: readonly UsageRecord[]): Spend {
  return rows.reduce<Spend>((total, row) => {
    const event = row.event;
    const cost = event["cost"];
    const usd = isRecord(cost) && typeof cost["totalUsd"] === "number" ? cost["totalUsd"] : null;
    return {
      usd: total.usd + (usd ?? 0),
      unpriced: total.unpriced + (usd === null ? 1 : 0),
      ms: total.ms + count(event["durationMs"]),
      calls: total.calls + 1,
    };
  }, NOTHING);
}

export function tokensOf(rows: readonly UsageRecord[]): Tokens {
  return rows.reduce<Tokens>((total, row) => {
    // A tool call spends no tokens and records none; only a model call does.
    const usage = row.event["usage"];
    if (!isRecord(usage)) return total;
    return {
      input: total.input + count(usage["inputTokens"]),
      output: total.output + count(usage["outputTokens"]),
      cached:
        total.cached +
        count(usage["cacheReadInputTokens"]) +
        count(usage["cacheCreationInputTokens"]),
    };
  }, NO_TOKENS);
}

/** Money as somebody reads it, with a floor when something could not be priced. */
export function readableSpend(spend: Spend): string {
  if (spend.calls === 0) return "cost not recorded";
  // Two decimals would render a few tenths of a cent as "$0.01", overstating
  // the cheap model whose whole point is that it is cheap; four decimals would
  // pad every ordinary figure with zeros it does not have.
  const money =
    spend.usd > 0 && spend.usd < 0.01
      ? `$${spend.usd.toFixed(4).replace(/0+$/, "")}`
      : `$${spend.usd.toFixed(2)}`;
  if (spend.unpriced === 0) return money;
  const calls =
    spend.unpriced === 1 ? "1 call unpriced" : `${String(spend.unpriced)} calls unpriced`;
  return `at least ${money} · ${calls}`;
}

export const readableTime = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;

/** Thousands as thousands: nobody reads 1,243,000 as a quantity of anything. */
const short = (tokens: number): string =>
  tokens >= 1000
    ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1).replace(/\.0$/, "")}k`
    : String(tokens);

/** Empty when nothing was recorded: a row of zeroes says something false. */
export function readableTokens(tokens: Tokens): string {
  if (tokens.input === 0 && tokens.output === 0) return "";
  const said = `${short(tokens.input)} in · ${short(tokens.output)} out`;
  return tokens.cached === 0 ? said : `${said} · ${short(tokens.cached)} cached`;
}

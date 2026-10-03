import { describe, expect, it } from "vitest";
import type { UsageRecord } from "@vo/core";
import { readableSpend, readableTokens, spendOf, tokensOf } from "./spend.js";

const at = new Date("2026-10-03T09:00:00Z");

const call = (overrides: Record<string, unknown> = {}): UsageRecord =>
  ({
    id: `u-${String(Math.random())}`,
    officeId: "office-1",
    taskId: "task-1",
    employeeId: "emp-ada",
    at,
    event: {
      kind: "llm_call",
      model: "claude-sonnet-5",
      durationMs: 1200,
      usage: {
        inputTokens: 1000,
        outputTokens: 250,
        cacheReadInputTokens: 400,
        cacheCreationInputTokens: 0,
      },
      cost: { totalUsd: 0.004 },
      ...overrides,
    },
  }) as unknown as UsageRecord;

describe("what a set of calls came to", () => {
  it("adds up what was spent, and how long it took", () => {
    const spend = spendOf([call(), call()]);

    expect(spend.usd).toBeCloseTo(0.008);
    expect(spend.calls).toBe(2);
    expect(spend.ms).toBe(2400);
  });

  it("counts what nobody could price rather than calling it free", () => {
    // A total holding an unpriced call is a floor, and saying so is the whole
    // reason the registry answers null instead of zero.
    const spend = spendOf([call(), call({ cost: null })]);

    expect(spend.usd).toBeCloseTo(0.004);
    expect(spend.unpriced).toBe(1);
  });

  it("is nothing for no calls at all", () => {
    expect(spendOf([])).toMatchObject({ usd: 0, calls: 0, unpriced: 0, ms: 0 });
  });

  it("survives an event that is not shaped the way it expects", () => {
    expect(spendOf([call({ cost: "free", durationMs: "ages" })]).calls).toBe(1);
  });
});

describe("what a set of calls cost in tokens", () => {
  it("adds up what went in and what came out", () => {
    const tokens = tokensOf([call(), call()]);

    expect(tokens.input).toBe(2000);
    expect(tokens.output).toBe(500);
  });

  it("counts what came from the cache apart, since it is the cheap half", () => {
    expect(tokensOf([call()]).cached).toBe(400);
  });

  it("counts nothing for a call that recorded nothing", () => {
    expect(tokensOf([call({ usage: undefined })])).toMatchObject({
      input: 0,
      output: 0,
      cached: 0,
    });
  });

  it("ignores a tool call, which spends no tokens", () => {
    expect(tokensOf([call({ kind: "tool_call", usage: undefined })]).input).toBe(0);
  });
});

describe("saying it out loud", () => {
  it("writes an ordinary figure in money", () => {
    expect(readableSpend(spendOf([call({ cost: { totalUsd: 1.5 } })]))).toBe("$1.50");
  });

  it("writes a few tenths of a cent without rounding it up to one", () => {
    // Two decimals would say "$0.01" of a model whose whole point is that it is
    // cheaper than that.
    expect(readableSpend(spendOf([call({ cost: { totalUsd: 0.0004 } })]))).toBe("$0.0004");
  });

  it("says a total is a floor when something in it had no price", () => {
    const said = readableSpend(spendOf([call(), call({ cost: null })]));

    expect(said).toMatch(/^at least /);
    expect(said).toContain("1 call unpriced");
  });

  it("says nothing was recorded rather than saying zero", () => {
    expect(readableSpend(spendOf([]))).toBe("cost not recorded");
  });

  it("writes thousands of tokens as thousands", () => {
    expect(readableTokens(tokensOf([call()]))).toContain("1k in");
    expect(readableTokens(tokensOf([call()]))).toContain("250 out");
  });

  it("says nothing at all when nothing was recorded", () => {
    expect(readableTokens(tokensOf([]))).toBe("");
  });
});

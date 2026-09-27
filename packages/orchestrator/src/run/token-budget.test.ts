import { describe, expect, it } from "vitest";
import { defaultModelRegistry, type Usage } from "@vo/llm";
import { BudgetExhaustedError, RunBudget, totalTokens } from "./token-budget.js";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheWrite,
});

const registry = defaultModelRegistry();
const model = { provider: "anthropic", model: "claude-opus-5" };

describe("totalTokens", () => {
  it("counts fresh input, output and both cache counters", () => {
    expect(totalTokens(usage(100, 50, 20, 10))).toBe(180);
    expect(totalTokens(usage(0, 0))).toBe(0);
  });
});

describe("RunBudget", () => {
  it("starts empty and accumulates usage across turns", () => {
    const budget = new RunBudget({ maxTotalTokens: 1_000 });
    expect(budget.spent.totalTokens).toBe(0);
    expect(budget.turns).toBe(0);
    budget.record(usage(100, 50));
    budget.record(usage(80, 20, 40));
    expect(budget.spent).toMatchObject({
      inputTokens: 180,
      outputTokens: 70,
      cacheReadInputTokens: 40,
      totalTokens: 290,
    });
    expect(budget.turns).toBe(2);
  });

  it("reports ok, then warn at the warning fraction, then exhausted at the hard limit", () => {
    const budget = new RunBudget({ maxTotalTokens: 1_000, warnAtFraction: 0.8 });
    expect(budget.state).toBe("ok");
    budget.record(usage(700, 0));
    expect(budget.state).toBe("ok");
    expect(budget.usedFraction).toBeCloseTo(0.7, 10);
    budget.record(usage(100, 0));
    expect(budget.state).toBe("warn");
    budget.record(usage(200, 0));
    expect(budget.state).toBe("exhausted");
    expect(budget.remaining.tokens).toBe(0);
  });

  it("stops a run on the hard token limit", () => {
    const budget = new RunBudget({ maxTotalTokens: 100 });
    budget.record(usage(60, 50));
    expect(budget.state).toBe("exhausted");
    expect(() => {
      budget.assertCanContinue();
    }).toThrow(BudgetExhaustedError);
    const err = (() => {
      try {
        budget.assertCanContinue();
        return null;
      } catch (e) {
        return e as BudgetExhaustedError;
      }
    })();
    expect(err?.reason).toBe("tokens");
    expect(err?.message).toMatch(/110.*100/);
  });

  it("stops a run on the hard output-token limit even when totals are fine", () => {
    const budget = new RunBudget({ maxTotalTokens: 1_000_000, maxOutputTokens: 100 });
    budget.record(usage(10, 150));
    expect(budget.state).toBe("exhausted");
    expect(() => {
      budget.assertCanContinue();
    }).toThrow(/output tokens/);
  });

  it("stops a run on the cost limit, priced through the registry", () => {
    const budget = new RunBudget({ maxUsd: 0.01 }, { registry, model });
    budget.record(usage(1_000_000, 0));
    expect(budget.spent.usd).toBeCloseTo(5, 6);
    expect(budget.state).toBe("exhausted");
    expect(() => {
      budget.assertCanContinue();
    }).toThrow(/cost/);
  });

  it("prices cached reads more cheaply than fresh input", () => {
    const fresh = new RunBudget({}, { registry, model });
    const cached = new RunBudget({}, { registry, model });
    fresh.record(usage(1_000, 0));
    cached.record(usage(0, 0, 1_000));
    expect(cached.spent.usd).toBeLessThan(fresh.spent.usd);
    expect(cached.spent.totalTokens).toBe(fresh.spent.totalTokens);
  });

  it("reports zero cost and no cost limit when no registry is given", () => {
    const budget = new RunBudget({ maxTotalTokens: 10 });
    budget.record(usage(1, 1));
    expect(budget.spent.usd).toBe(0);
    expect(budget.remaining.usd).toBeNull();
  });

  it("refuses a call whose estimated prompt would exceed the remaining budget", () => {
    const budget = new RunBudget({ maxTotalTokens: 1_000 });
    budget.record(usage(600, 100));
    expect(budget.canAfford(200)).toEqual({ allowed: true });
    expect(budget.canAfford(400)).toEqual({ allowed: false, reason: "tokens", remaining: 300 });
  });

  it("treats an absent limit as unlimited", () => {
    const budget = new RunBudget({});
    budget.record(usage(10_000_000, 10_000_000));
    expect(budget.state).toBe("ok");
    expect(budget.remaining.tokens).toBeNull();
    expect(budget.usedFraction).toBe(0);
    expect(budget.canAfford(1_000_000)).toEqual({ allowed: true });
    expect(() => {
      budget.assertCanContinue();
    }).not.toThrow();
  });

  it("rejects non-positive limits and fractions outside 0..1", () => {
    expect(() => new RunBudget({ maxTotalTokens: 0 })).toThrow(/maxTotalTokens/);
    expect(() => new RunBudget({ maxUsd: -1 })).toThrow(/maxUsd/);
    expect(() => new RunBudget({ maxTotalTokens: 10, warnAtFraction: 1.5 })).toThrow(
      /warnAtFraction/,
    );
  });

  it("serializes and restores so a resumed run keeps its spend", () => {
    const budget = new RunBudget({ maxTotalTokens: 1_000 }, { registry, model });
    budget.record(usage(100, 50, 10));
    const restored = RunBudget.restore(budget.snapshot(), { registry, model });
    expect(restored.spent).toEqual(budget.spent);
    expect(restored.turns).toBe(1);
    restored.record(usage(10, 10));
    expect(restored.spent.totalTokens).toBe(180);
  });
});

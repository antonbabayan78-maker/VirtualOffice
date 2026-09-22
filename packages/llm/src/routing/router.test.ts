import { describe, expect, it } from "vitest";
import { FakeLlmProvider, reply, type ScriptStep } from "../fake/fake-provider.js";
import { LlmProviderError, type CompletionRequest, type StreamEvent } from "../provider/types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
  applyTiering,
  policyFromLlmConfig,
  Router,
  RoutingExhaustedError,
  type RoutingPolicy,
  type TieringRule,
} from "./router.js";

const base: Omit<CompletionRequest, "model"> = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};
const policy: RoutingPolicy = {
  primary: { provider: "anthropic", model: "claude-opus-5" },
  fallbacks: [{ provider: "openai", model: "gpt-5" }],
};
const err = (
  code: ConstructorParameters<typeof LlmProviderError>[0],
  status?: number,
  retryAfterMs?: number,
) =>
  new LlmProviderError(code, `${code}!`, {
    ...(status === undefined ? {} : { status }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

function harness(
  scripts: { anthropic?: readonly ScriptStep[]; openai?: readonly ScriptStep[] },
  breaker?: CircuitBreaker,
) {
  const anthropic = new FakeLlmProvider({ id: "anthropic", script: scripts.anthropic ?? [] });
  const openai = new FakeLlmProvider({ id: "openai", script: scripts.openai ?? [] });
  const sleeps: number[] = [];
  const router = new Router({
    providers: { anthropic, openai },
    retry: { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 5_000, jitter: () => 0 },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    ...(breaker ? { breaker } : {}),
  });
  return { anthropic, openai, router, sleeps };
}

describe("Router.complete", () => {
  it("uses the primary model when it succeeds", async () => {
    const h = harness({ anthropic: [reply("primary")] });
    const routed = await h.router.complete(base, policy);
    expect(routed.response.content).toEqual([{ type: "text", text: "primary" }]);
    expect(routed.model).toEqual(policy.primary);
    expect(routed.attempts).toEqual([
      { provider: "anthropic", model: "claude-opus-5", outcome: "success", delayMs: 0 },
    ]);
    expect(h.anthropic.calls[0]?.model).toBe("claude-opus-5");
    expect(h.openai.calls).toHaveLength(0);
  });

  it("retries a rate limit on the same model, honouring retry-after", async () => {
    const h = harness({ anthropic: [err("rate_limited", 429, 1_500), reply("second try")] });
    const routed = await h.router.complete(base, policy);
    expect(routed.response.content).toEqual([{ type: "text", text: "second try" }]);
    expect(routed.attempts.map((a) => a.outcome)).toEqual(["retry", "success"]);
    expect(h.sleeps).toEqual([1_500]);
  });

  it("uses exponential backoff when no retry-after is given", async () => {
    const h = harness({
      anthropic: [err("unavailable", 500), err("unavailable", 503)],
      openai: [err("timeout"), reply("ok")],
    });
    const routed = await h.router.complete(base, policy);
    expect(routed.model).toEqual({ provider: "openai", model: "gpt-5" });
    expect(routed.attempts.map((a) => `${a.provider}:${a.outcome}`)).toEqual([
      "anthropic:retry",
      "anthropic:fallback",
      "openai:retry",
      "openai:success",
    ]);
    expect(h.sleeps).toEqual([200, 200]);
  });

  it("falls back on 5xx and timeouts after exhausting retries on a candidate", async () => {
    const h = harness({
      anthropic: [err("timeout"), err("unavailable", 529)],
      openai: [reply("fallback")],
    });
    const routed = await h.router.complete(base, policy);
    expect(routed.response.content).toEqual([{ type: "text", text: "fallback" }]);
    expect(h.anthropic.calls).toHaveLength(2);
    expect(h.openai.calls).toHaveLength(1);
  });

  it("never falls back or retries on auth errors", async () => {
    const h = harness({ anthropic: [err("auth", 401)], openai: [reply("should not run")] });
    await expect(h.router.complete(base, policy)).rejects.toMatchObject({ code: "auth" });
    expect(h.anthropic.calls).toHaveLength(1);
    expect(h.openai.calls).toHaveLength(0);
    expect(h.sleeps).toEqual([]);
  });

  it("never falls back on invalid requests either", async () => {
    const h = harness({
      anthropic: [err("invalid_request", 400)],
      openai: [reply("should not run")],
    });
    await expect(h.router.complete(base, policy)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(h.openai.calls).toHaveLength(0);
  });

  it("wraps non-provider errors as unknown and does not retry them", async () => {
    const h = harness({
      anthropic: [reply("unused")],
      openai: [reply("unused")],
    });
    const throwing = new FakeLlmProvider({
      id: "anthropic",
      handler: () => {
        throw new Error("boom");
      },
    });
    const router = new Router({
      providers: { anthropic: throwing, openai: h.openai },
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: () => 0 },
      sleep: () => Promise.resolve(),
    });
    await expect(router.complete(base, policy)).rejects.toMatchObject({
      code: "unknown",
      message: expect.stringContaining("boom") as string,
    });
    expect(h.openai.calls).toHaveLength(0);
  });

  it("throws RoutingExhaustedError with the full attempt log when every candidate fails", async () => {
    const h = harness({
      anthropic: [err("unavailable", 500), err("unavailable", 500)],
      openai: [err("rate_limited", 429), err("rate_limited", 429)],
    });
    const e = await h.router.complete(base, policy).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RoutingExhaustedError);
    const exhausted = e as RoutingExhaustedError;
    expect(exhausted.attempts).toHaveLength(4);
    expect(exhausted.lastError.code).toBe("rate_limited");
    expect(exhausted.message).toMatch(/anthropic\/claude-opus-5.*openai\/gpt-5/);
  });

  it("fails clearly when a policy names a provider that is not configured", async () => {
    const h = harness({ anthropic: [reply("x")] });
    await expect(
      h.router.complete(base, { primary: { provider: "mystery", model: "m" }, fallbacks: [] }),
    ).rejects.toThrow(/no provider registered for "mystery"/);
  });

  it("skips candidates whose provider breaker is open and records it", async () => {
    let now = 0;
    const breaker = new CircuitBreaker(
      { failureThreshold: 1, windowMs: 60_000, cooldownMs: 30_000, halfOpenMaxCalls: 1 },
      () => now,
    );
    const h = harness(
      {
        anthropic: [err("unavailable", 503), err("unavailable", 503), reply("back")],
        openai: [reply("via openai"), reply("via openai again")],
      },
      breaker,
    );
    const first = await h.router.complete(base, policy);
    expect(first.model.provider).toBe("openai");
    expect(breaker.state("anthropic")).toBe("open");
    const second = await h.router.complete(base, policy);
    expect(second.attempts[0]).toMatchObject({
      provider: "anthropic",
      outcome: "skipped_open_breaker",
    });
    expect(h.anthropic.calls).toHaveLength(2);
    now = 30_000;
    const third = await h.router.complete(base, policy);
    expect(third.model.provider).toBe("anthropic");
    expect(breaker.state("anthropic")).toBe("closed");
  });
});

describe("Router.stream", () => {
  it("falls back when a provider fails before yielding, but not after events have been delivered", async () => {
    const failing = new FakeLlmProvider({
      id: "anthropic",
      script: [err("unavailable", 503), err("unavailable", 503)],
    });
    const ok = new FakeLlmProvider({ id: "openai", script: [reply("streamed")] });
    const router = new Router({
      providers: { anthropic: failing, openai: ok },
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, jitter: () => 0 },
      sleep: () => Promise.resolve(),
    });
    const events: StreamEvent[] = [];
    for await (const e of router.stream(base, policy)) events.push(e);
    expect(events.at(-1)?.type).toBe("done");
    expect(
      events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as { text: string }).text)
        .join(""),
    ).toBe("streamed");

    const midway = new FakeLlmProvider({
      id: "anthropic",
      handler: () => reply("partial"),
    });
    midway.stream = async function* () {
      yield { type: "text_delta", text: "par" };
      await Promise.resolve();
      throw err("unavailable", 503);
    };
    const router2 = new Router({
      providers: { anthropic: midway, openai: ok },
      sleep: () => Promise.resolve(),
    });
    const seen: StreamEvent[] = [];
    const e = await (async () => {
      for await (const ev of router2.stream(base, policy)) seen.push(ev);
    })().catch((x: unknown) => x);
    expect(seen).toHaveLength(1);
    expect(e).toMatchObject({ code: "unavailable" });
  });
});

describe("tiering", () => {
  const rules: TieringRule[] = [
    {
      when: { priority: ["urgent", "high"] },
      use: { provider: "anthropic", model: "claude-opus-5" },
    },
    {
      when: { tags: ["summarize", "classify"] },
      use: { provider: "anthropic", model: "claude-haiku-4-5" },
    },
    { when: { maxPromptTokens: 20_000 }, use: { provider: "anthropic", model: "claude-sonnet-5" } },
  ];
  const fallback = { provider: "anthropic", model: "claude-sonnet-5" };

  it("picks the first matching rule and otherwise the default", () => {
    expect(applyTiering(rules, fallback, { priority: "urgent" })).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
    expect(applyTiering(rules, fallback, { priority: "normal", tags: ["classify"] })).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(applyTiering(rules, fallback, { priority: "normal", promptTokens: 5_000 })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(applyTiering(rules, fallback, { priority: "normal", promptTokens: 50_000 })).toEqual(
      fallback,
    );
    expect(applyTiering([], fallback, {})).toEqual(fallback);
  });

  it("requires every condition of a rule to hold", () => {
    const strict: TieringRule[] = [
      {
        when: { priority: ["high"], tags: ["code"] },
        use: { provider: "anthropic", model: "claude-opus-5" },
      },
    ];
    expect(applyTiering(strict, fallback, { priority: "high", tags: ["docs"] })).toEqual(fallback);
    expect(applyTiering(strict, fallback, { priority: "high", tags: ["docs", "code"] })).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
    });
  });

  it("builds a routing policy from an employee LLM config", () => {
    expect(
      policyFromLlmConfig({
        provider: "anthropic",
        model: "claude-sonnet-5",
        params: {},
        fallbacks: [
          { provider: "openai", model: "gpt-5" },
          { provider: "ollama", model: "llama3" },
        ],
      }),
    ).toEqual({
      primary: { provider: "anthropic", model: "claude-sonnet-5" },
      fallbacks: [
        { provider: "openai", model: "gpt-5" },
        { provider: "ollama", model: "llama3" },
      ],
    });
  });
});

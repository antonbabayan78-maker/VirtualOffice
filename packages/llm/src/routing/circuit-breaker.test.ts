import { describe, expect, it } from "vitest";
import { CircuitBreaker } from "./circuit-breaker.js";

describe("CircuitBreaker", () => {
  const make = () => {
    let now = 1_000_000;
    const breaker = new CircuitBreaker(
      { failureThreshold: 3, windowMs: 10_000, cooldownMs: 5_000, halfOpenMaxCalls: 1 },
      () => now,
    );
    return { breaker, tick: (ms: number) => (now += ms) };
  };

  it("starts closed and stays closed below the failure threshold", () => {
    const { breaker } = make();
    expect(breaker.state("anthropic")).toBe("closed");
    breaker.recordFailure("anthropic");
    breaker.recordFailure("anthropic");
    expect(breaker.state("anthropic")).toBe("closed");
    expect(breaker.canRequest("anthropic")).toBe(true);
  });

  it("opens at the threshold and rejects requests during the cooldown", () => {
    const { breaker, tick } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure("anthropic");
    expect(breaker.state("anthropic")).toBe("open");
    expect(breaker.canRequest("anthropic")).toBe(false);
    tick(4_999);
    expect(breaker.canRequest("anthropic")).toBe(false);
    expect(breaker.state("openai")).toBe("closed");
  });

  it("half-opens after the cooldown, allowing a limited number of trial calls", () => {
    const { breaker, tick } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure("anthropic");
    tick(5_000);
    expect(breaker.state("anthropic")).toBe("half_open");
    expect(breaker.canRequest("anthropic")).toBe(true);
    expect(breaker.canRequest("anthropic")).toBe(false);
  });

  it("closes on a half-open success and re-opens on a half-open failure", () => {
    const { breaker, tick } = make();
    for (let i = 0; i < 3; i++) breaker.recordFailure("anthropic");
    tick(5_000);
    expect(breaker.canRequest("anthropic")).toBe(true);
    breaker.recordSuccess("anthropic");
    expect(breaker.state("anthropic")).toBe("closed");
    expect(breaker.canRequest("anthropic")).toBe(true);

    for (let i = 0; i < 3; i++) breaker.recordFailure("anthropic");
    tick(5_000);
    expect(breaker.canRequest("anthropic")).toBe(true);
    breaker.recordFailure("anthropic");
    expect(breaker.state("anthropic")).toBe("open");
    tick(4_999);
    expect(breaker.canRequest("anthropic")).toBe(false);
    tick(1);
    expect(breaker.state("anthropic")).toBe("half_open");
  });

  it("only counts failures inside the sliding window", () => {
    const { breaker, tick } = make();
    breaker.recordFailure("anthropic");
    breaker.recordFailure("anthropic");
    tick(10_001);
    breaker.recordFailure("anthropic");
    expect(breaker.state("anthropic")).toBe("closed");
  });

  it("a success while closed clears recent failures", () => {
    const { breaker } = make();
    breaker.recordFailure("anthropic");
    breaker.recordFailure("anthropic");
    breaker.recordSuccess("anthropic");
    breaker.recordFailure("anthropic");
    expect(breaker.state("anthropic")).toBe("closed");
  });
});

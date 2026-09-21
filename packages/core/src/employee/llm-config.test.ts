import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "../shared/result.js";
import { parseLlmConfig } from "./llm-config.js";

describe("parseLlmConfig", () => {
  it("accepts provider and model with empty fallbacks and no params by default", () => {
    expect(unwrap(parseLlmConfig({ provider: "anthropic", model: "claude-sonnet-5" }))).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      params: {},
      fallbacks: [],
    });
  });

  it("accepts params and an ordered fallback chain", () => {
    const cfg = unwrap(
      parseLlmConfig({
        provider: "anthropic",
        model: "claude-fable-5-1",
        params: { temperature: 0.2, maxOutputTokens: 4096 },
        fallbacks: [
          { provider: "openai", model: "gpt-5" },
          { provider: "ollama", model: "llama3" },
        ],
      }),
    );
    expect(cfg.params).toEqual({ temperature: 0.2, maxOutputTokens: 4096 });
    expect(cfg.fallbacks.map((f) => f.provider)).toEqual(["openai", "ollama"]);
  });

  it("rejects missing or blank provider and model", () => {
    for (const input of [
      { model: "x" },
      { provider: "", model: "x" },
      { provider: "a", model: " " },
    ]) {
      const r = parseLlmConfig(input);
      expect(isErr(r), JSON.stringify(input)).toBe(true);
    }
  });

  it("rejects temperature outside 0..2 and non-positive maxOutputTokens", () => {
    for (const params of [
      { temperature: -0.1 },
      { temperature: 2.1 },
      { maxOutputTokens: 0 },
      { maxOutputTokens: 1.5 },
    ]) {
      const r = parseLlmConfig({ provider: "a", model: "b", params });
      expect(isErr(r), JSON.stringify(params)).toBe(true);
      if (isErr(r)) expect(r.error[0]?.path.startsWith("params.")).toBe(true);
    }
  });

  it("rejects malformed fallbacks with an indexed path", () => {
    const r = parseLlmConfig({ provider: "a", model: "b", fallbacks: [{ provider: "openai" }] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error[0]?.path).toBe("fallbacks[0].model");
    expect(isErr(parseLlmConfig({ provider: "a", model: "b", fallbacks: "none" }))).toBe(true);
  });

  it("rejects non-object params and non-object fallback entries", () => {
    const params = parseLlmConfig({ provider: "a", model: "b", params: "hot" });
    expect(isErr(params)).toBe(true);
    if (isErr(params)) expect(params.error[0]?.path).toBe("params");
    const fallback = parseLlmConfig({ provider: "a", model: "b", fallbacks: ["openai/gpt-5"] });
    expect(isErr(fallback)).toBe(true);
    if (isErr(fallback)) expect(fallback.error[0]?.path).toBe("fallbacks[0]");
  });

  it("rejects non-object input", () => {
    expect(isErr(parseLlmConfig(null))).toBe(true);
    expect(isErr(parseLlmConfig("anthropic/claude"))).toBe(true);
  });
});

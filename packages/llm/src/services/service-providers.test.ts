import {
  createLlmService,
  unwrap,
  type LlmService,
  type LlmServiceId,
  type OfficeId,
} from "@vo/core";
import { describe, expect, it } from "vitest";
import type { Usage } from "../provider/types.js";
import { UnknownModelError } from "../registry/model-registry.js";
import { providersFor, registryFor } from "./service-providers.js";

const officeId = "o1" as OfficeId;
const at = new Date("2026-10-03T09:00:00Z");
let next = 0;

const service = (overrides: Record<string, unknown> = {}): LlmService =>
  unwrap(
    createLlmService(
      {
        officeId,
        kind: "openai-compatible",
        name: "openai",
        baseUrl: "https://api.openai.com/v1",
        ...overrides,
      } as never,
      [],
      { id: () => `svc-${String(++next)}` as LlmServiceId, now: () => at },
    ),
  );

const usage: Usage = {
  inputTokens: 1_000_000,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

describe("the providers an office's services add up to", () => {
  it("knows each one by the name an employee asks for", async () => {
    const providers = await providersFor(
      [service({ name: "grok", baseUrl: "https://api.x.ai/v1" })],
      {
        env: {},
      },
    );

    expect([...providers.keys()]).toEqual(["grok"]);
    expect(providers.get("grok")?.id).toBe("grok");
  });

  it("takes the key out of the variable the service names", async () => {
    const providers = await providersFor([service({ tokenEnv: "OPENAI_API_KEY" })], {
      env: { OPENAI_API_KEY: "sk-live-1" },
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [] }), {
            headers: { "content-type": "application/json" },
          }),
        ),
    });

    expect(providers.has("openai")).toBe(true);
  });

  it("asks the office for a key it is keeping, rather than holding one itself", async () => {
    const asked: string[] = [];

    const providers = await providersFor([service({ secretRef: "vault://abc" })], {
      env: {},
      secret: (ref) => {
        asked.push(ref);
        return Promise.resolve("sk-live-2");
      },
    });

    expect(asked).toEqual(["vault://abc"]);
    expect(providers.has("openai")).toBe(true);
  });

  it("leaves out a service whose key cannot be found, and says why", async () => {
    // A provider that answers 401 to every call is worse than one that is
    // plainly absent: the turn would spend its attempts on a settled failure.
    const problems: string[] = [];

    const providers = await providersFor([service({ tokenEnv: "OPENAI_API_KEY" })], {
      env: {},
      onProblem: (message) => problems.push(message),
    });

    expect(providers.has("openai")).toBe(false);
    expect(problems[0]).toContain("OPENAI_API_KEY");
    expect(problems[0]).toContain("openai");
  });

  it("leaves out one whose kept key the office no longer has", async () => {
    const problems: string[] = [];

    const providers = await providersFor([service({ secretRef: "vault://gone" })], {
      env: {},
      secret: () => Promise.resolve(null),
      onProblem: (message) => problems.push(message),
    });

    expect(providers.has("openai")).toBe(false);
    expect(problems[0]).toMatch(/vault:\/\/gone/);
  });

  it("builds a service that needs no key at all, which is the local case", async () => {
    const providers = await providersFor(
      [service({ name: "workshop", baseUrl: "http://10.0.0.12:11434/v1" })],
      { env: {} },
    );

    expect(providers.has("workshop")).toBe(true);
  });

  it("leaves out one that is switched off, without forgetting it elsewhere", async () => {
    const providers = await providersFor([service({ enabled: false })], { env: {} });

    expect(providers.size).toBe(0);
  });

  it("asks for the office's own provider for the built-in kind, and nothing else", async () => {
    const built: string[] = [];
    const anthropic = service({ kind: "anthropic", name: "anthropic", baseUrl: undefined });

    const providers = await providersFor([anthropic], {
      env: { ANTHROPIC_API_KEY: "sk-ant" },
      anthropic: (svc, key) => {
        built.push(`${svc.name}:${key ?? "none"}`);
        return {
          id: svc.name,
          complete: () => Promise.reject(new Error("never called")),
          stream: () => [] as never,
        };
      },
    });

    expect(providers.has("anthropic")).toBe(true);
    expect(built).toEqual(["anthropic:none"]);
  });

  it("leaves out the built-in kind when nobody handed it a way to build one", async () => {
    const problems: string[] = [];
    const anthropic = service({ kind: "anthropic", name: "anthropic", baseUrl: undefined });

    const providers = await providersFor([anthropic], {
      env: {},
      onProblem: (m) => problems.push(m),
    });

    expect(providers.size).toBe(0);
    expect(problems).toHaveLength(1);
  });

  it("goes on past one it cannot build, so one bad service does not stop the office", async () => {
    const providers = await providersFor(
      [
        service({ name: "broken", tokenEnv: "MISSING_KEY" }),
        service({ name: "workshop", baseUrl: "http://localhost:11434/v1" }),
      ],
      { env: {} },
    );

    expect([...providers.keys()]).toEqual(["workshop"]);
  });
});

describe("what the office's services cost", () => {
  it("prices a model nobody has heard of, because the owner typed what it costs", () => {
    const registry = registryFor([
      service({
        name: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        models: [{ id: "deepseek-v4", pricing: { inputPerMTok: 0.28, outputPerMTok: 1.1 } }],
      }),
    ]);

    expect(registry.costOf("deepseek/deepseek-v4", usage).totalUsd).toBeCloseTo(0.28, 6);
    expect(registry.costOf("deepseek/deepseek-v4", usage).pricingSource).toBe("model");
  });

  it("says a model nobody priced is not priced, rather than calling it free", () => {
    // Free is a figure, and a wrong one. The office reports the call as
    // unpriced and says the total is a floor.
    const registry = registryFor([service({ models: [{ id: "gpt-5" }] })]);

    expect(() => registry.costOf("openai/gpt-5", usage)).toThrow(UnknownModelError);
  });

  it("keeps the models the office already knows", () => {
    const registry = registryFor([]);

    expect(registry.has("anthropic/claude-sonnet-5")).toBe(true);
  });

  it("carries what a model can hold, where the service said", () => {
    const registry = registryFor([
      service({
        models: [
          {
            id: "gpt-5",
            displayName: "GPT-5",
            contextWindow: 400_000,
            maxOutputTokens: 128_000,
            pricing: { inputPerMTok: 1.25, outputPerMTok: 10 },
          },
        ],
      }),
    ]);

    expect(registry.require("openai/gpt-5")).toMatchObject({
      displayName: "GPT-5",
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
    });
  });

  it("guesses low about a model that never said, so a turn compacts rather than overflows", () => {
    const registry = registryFor([
      service({ models: [{ id: "gpt-5", pricing: { inputPerMTok: 1, outputPerMTok: 2 } }] }),
    ]);

    const spec = registry.require("openai/gpt-5");
    expect(spec.contextWindow).toBeLessThanOrEqual(32_768);
    expect(spec.maxOutputTokens).toBeLessThan(spec.contextWindow);
  });

  it("prices a call on a service that has since been switched off", () => {
    // Usage is priced long after the call, sometimes after somebody turned the
    // service off. What it cost did not change.
    const registry = registryFor([
      service({
        enabled: false,
        models: [{ id: "gpt-5", pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }],
      }),
    ]);

    expect(registry.has("openai/gpt-5")).toBe(true);
  });

  it("says a model reads its cache cheaply only when the service said so", () => {
    const registry = registryFor([
      service({
        models: [
          { id: "plain", pricing: { inputPerMTok: 1, outputPerMTok: 2 } },
          { id: "cached", pricing: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1 } },
        ],
      }),
    ]);

    expect(registry.require("openai/plain").capabilities.promptCaching).toBe(false);
    expect(registry.require("openai/cached").capabilities.promptCaching).toBe(true);
    // Nothing read from a cache costs nothing, which is what an absent price means.
    expect(registry.require("openai/plain").pricing.cacheReadPerMTok).toBe(1);
  });

  it("calls a model on your own machine a local one, which is how the router ranks it", () => {
    const registry = registryFor([
      service({
        name: "workshop",
        baseUrl: "http://localhost:11434/v1",
        models: [{ id: "qwen3-coder", pricing: { inputPerMTok: 0, outputPerMTok: 0 } }],
      }),
    ]);

    expect(registry.require("workshop/qwen3-coder").tier).toBe("local");
  });

  it("does not let a service shadow a model the office already prices", () => {
    // Otherwise an office could rename what a past call cost by adding a
    // service, and `register` would throw in the middle of a tick.
    const problems: string[] = [];

    const registry = registryFor(
      [
        service({
          name: "anthropic",
          kind: "anthropic",
          baseUrl: undefined,
          models: [{ id: "claude-sonnet-5", pricing: { inputPerMTok: 999, outputPerMTok: 999 } }],
        }),
      ],
      { onProblem: (message) => problems.push(message) },
    );

    expect(registry.require("anthropic/claude-sonnet-5").pricing.inputPerMTok).toBe(2);
    expect(problems[0]).toContain("claude-sonnet-5");
  });
});

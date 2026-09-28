import { describe, expect, it } from "vitest";
import * as registryEntry from "./index.js";

/**
 * This entry point exists so a browser can list models without the provider
 * adapters, which carry a vendor SDK meant for a server. If someone re-exports
 * an adapter from here, a canvas build quietly gains a few hundred kilobytes of
 * Node-flavoured code — so the surface is asserted rather than assumed.
 */
describe("the registry entry point", () => {
  it("offers the registry and the models in it", () => {
    expect(typeof registryEntry.defaultModelRegistry).toBe("function");
    expect(registryEntry.defaultModelRegistry().list().length).toBeGreaterThan(0);
  });

  it("prices a call, which is what a dashboard needs from it", () => {
    const cost = registryEntry.defaultModelRegistry().costOf(
      { provider: "anthropic", model: "claude-sonnet-5" },
      {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    );
    expect(cost.totalUsd).toBeGreaterThan(0);
  });

  it("carries no provider adapter, which is the whole point of it", () => {
    const surface = Object.keys(registryEntry);
    expect(surface).not.toContain("AnthropicProvider");
    expect(surface).not.toContain("createAnthropicProvider");
    expect(surface.some((name) => name.toLowerCase().includes("provider"))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { createLlmService, unwrap, type LlmServiceId, type OfficeId } from "@vo/core";
import type { ApiClient, ApiResult } from "@vo/api-client";
import { officeProviders } from "./office-providers.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-10-03T09:00:00Z");
let next = 0;

const service = (overrides: Record<string, unknown> = {}) =>
  unwrap(
    createLlmService(
      {
        officeId,
        kind: "openai-compatible",
        name: "workshop",
        baseUrl: "http://localhost:11434/v1",
        ...overrides,
      } as never,
      [],
      { id: () => `svc-${String(++next)}` as LlmServiceId, now: () => at },
    ),
  );

const api = (overrides: Partial<ApiClient> = {}): ApiClient => {
  const unused = () => Promise.reject(new Error("not used here"));
  return {
    listServices: () => Promise.resolve({ ok: true, value: [] } as ApiResult<never[]>),
    serviceCredential: unused,
    ...overrides,
  } as unknown as ApiClient;
};

describe("the services a worker can call for its office", () => {
  it("answers with the one the employee names", async () => {
    const { lookup } = officeProviders(
      api({ listServices: () => Promise.resolve({ ok: true, value: [service()] }) }),
      "office-1",
    );

    const found = await lookup({ provider: "workshop", model: "qwen3-coder" });

    expect(found?.id).toBe("workshop");
  });

  it("answers with nothing for a service this office does not have", async () => {
    // Nothing is what the turn reads as "use the one you were built with".
    const { lookup } = officeProviders(api(), "office-1");

    expect(await lookup({ provider: "openai", model: "gpt-5" })).toBeNull();
  });

  it("asks the office for a key it is keeping, since a worker holds none", async () => {
    const asked: string[] = [];
    const kept = service({ secretRef: "vault://abc" });
    const { lookup } = officeProviders(
      api({
        listServices: () => Promise.resolve({ ok: true, value: [kept] }),
        serviceCredential: (id) => {
          asked.push(id);
          return Promise.resolve({ ok: true, value: "sk-live-1" });
        },
      }),
      "office-1",
    );

    expect(await lookup({ provider: "workshop", model: "qwen3-coder" })).not.toBeNull();
    expect(asked).toEqual([kept.id]);
  });

  it("asks for nothing for a service that keeps nothing", async () => {
    // A model on this machine needs no key, and a request for one would be a
    // round trip on every turn for an answer that is always the same.
    const asked: string[] = [];
    const { lookup } = officeProviders(
      api({
        listServices: () => Promise.resolve({ ok: true, value: [service()] }),
        serviceCredential: (id) => {
          asked.push(id);
          return Promise.resolve({ ok: true, value: null });
        },
      }),
      "office-1",
    );

    await lookup({ provider: "workshop", model: "qwen3-coder" });

    expect(asked).toEqual([]);
  });

  it("takes the key out of this process's own environment when the service names a variable", async () => {
    const named = service({
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      tokenEnv: "OPENAI_API_KEY",
    });
    const { lookup } = officeProviders(
      api({ listServices: () => Promise.resolve({ ok: true, value: [named] }) }),
      "office-1",
      { env: { OPENAI_API_KEY: "sk-live-2" } },
    );

    expect(await lookup({ provider: "openai", model: "gpt-5" })).not.toBeNull();
  });

  it("says why it is leaving one out, so a run on the wrong model is never silent", async () => {
    const problems: string[] = [];
    const named = service({
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      tokenEnv: "OPENAI_API_KEY",
    });
    const { lookup } = officeProviders(
      api({ listServices: () => Promise.resolve({ ok: true, value: [named] }) }),
      "office-1",
      { env: {}, onProblem: (message) => problems.push(message) },
    );

    expect(await lookup({ provider: "openai", model: "gpt-5" })).toBeNull();
    expect(problems.join(" ")).toContain("OPENAI_API_KEY");
  });

  it("asks again when the office's services have changed", async () => {
    // A service added, repriced or switched off on the canvas has to take
    // effect on the next turn, not on the next restart.
    let answer = [service()];
    let asks = 0;
    const { lookup } = officeProviders(
      api({
        listServices: () => {
          asks += 1;
          return Promise.resolve({ ok: true, value: answer });
        },
      }),
      "office-1",
    );

    expect(await lookup({ provider: "workshop", model: "qwen3-coder" })).not.toBeNull();
    answer = [service({ enabled: false })];
    expect(await lookup({ provider: "workshop", model: "qwen3-coder" })).toBeNull();
    expect(asks).toBe(2);
  });

  it("builds the same provider again while the office's answer holds", async () => {
    // Rebuilding per turn is cheap, but an adapter that was handed a key
    // should not fetch it again for every call it makes.
    let keys = 0;
    const kept = service({ secretRef: "vault://abc" });
    const { lookup } = officeProviders(
      api({
        listServices: () => Promise.resolve({ ok: true, value: [kept] }),
        serviceCredential: () => {
          keys += 1;
          return Promise.resolve({ ok: true, value: "sk-live-1" });
        },
      }),
      "office-1",
    );

    const first = await lookup({ provider: "workshop", model: "qwen3-coder" });
    const second = await lookup({ provider: "workshop", model: "qwen3-coder" });

    expect(second).toBe(first);
    expect(keys).toBe(1);
  });

  it("calls nothing its own when the office cannot be reached", async () => {
    // The turn then runs on the provider it was built with, which is what a
    // worker did before any of this existed.
    const problems: string[] = [];
    const { lookup } = officeProviders(
      api({
        listServices: () => Promise.resolve({ ok: false, kind: "transport", message: "down" }),
      }),
      "office-1",
      { onProblem: (message) => problems.push(message) },
    );

    expect(await lookup({ provider: "workshop", model: "qwen3-coder" })).toBeNull();
    expect(problems).toHaveLength(1);
  });

  it("prices every model its services offer, as of the last time it asked", async () => {
    const { lookup, prices } = officeProviders(
      api({
        listServices: () =>
          Promise.resolve({
            ok: true,
            value: [
              service({
                models: [{ id: "qwen3-coder", pricing: { inputPerMTok: 0.1, outputPerMTok: 0.2 } }],
              }),
            ],
          }),
      }),
      "office-1",
    );

    // Read after resolving a provider, which is the order a turn does it in:
    // the price list is a snapshot of the office's last answer.
    await lookup({ provider: "workshop", model: "qwen3-coder" });

    expect(prices().has("workshop/qwen3-coder")).toBe(true);
    // And still everything the office already knew.
    expect(prices().has("anthropic/claude-sonnet-5")).toBe(true);
  });

  it("prices what the office already knew before it has asked anything", () => {
    // Metering must work on the very first call, before any service is known.
    const { prices } = officeProviders(api(), "office-1");

    expect(prices().has("anthropic/claude-sonnet-5")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { isErr, unwrap } from "../shared/result.js";
import type { OfficeId } from "../office/office.js";
import {
  createLlmService,
  updateLlmService,
  type CreateLlmServiceInput,
  type LlmService,
  type LlmServiceId,
} from "./llm-service.js";

const officeId = "office-1" as OfficeId;
const at = new Date("2026-10-03T09:00:00Z");
const deps = { id: () => "svc-1" as LlmServiceId, now: () => at };

const input = (overrides: Partial<CreateLlmServiceInput> = {}): CreateLlmServiceInput => ({
  officeId,
  kind: "openai-compatible",
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  ...overrides,
});

const make = (overrides: Partial<CreateLlmServiceInput> = {}, existing: { name: string }[] = []) =>
  createLlmService(input(overrides), existing, deps);

/** The same, with no address said at all, which is not the same as an empty one. */
const withNoAddress = (overrides: Partial<CreateLlmServiceInput> = {}) => {
  const { baseUrl: _unsaid, ...rest } = input(overrides);
  return createLlmService(rest, [], deps);
};

describe("a service an office can call a model on", () => {
  it("has a name an employee can ask for by", () => {
    const service = unwrap(make());

    expect(service).toMatchObject({
      id: "svc-1",
      officeId,
      kind: "openai-compatible",
      name: "openai",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      createdAt: at,
    });
  });

  it("offers nothing until somebody says what it has", () => {
    // A service with no models is not broken: it has not been asked yet, and
    // asking it is a button on the canvas.
    expect(unwrap(make()).models).toEqual([]);
  });

  it("refuses a name that is not a name", () => {
    expect(isErr(make({ name: "Open AI" }))).toBe(true);
    expect(isErr(make({ name: "" }))).toBe(true);
  });

  it("refuses a second service with a name this office already uses", () => {
    expect(isErr(make({}, [{ name: "openai" }]))).toBe(true);
  });

  it("refuses a kind nothing can perform", () => {
    expect(isErr(make({ kind: "telepathy" as never }))).toBe(true);
  });
});

describe("where the service is", () => {
  it("takes an address over https", () => {
    expect(unwrap(make({ baseUrl: "https://api.x.ai/v1" })).baseUrl).toBe("https://api.x.ai/v1");
  });

  it("takes a plain address on this machine, which is where a model is tried out", () => {
    expect(isErr(make({ baseUrl: "http://localhost:11434/v1" }))).toBe(false);
    expect(isErr(make({ baseUrl: "http://127.0.0.1:11434/v1" }))).toBe(false);
  });

  it("takes a plain address inside the company network, which is the point of a local model", () => {
    // A box at 10.0.0.12 is the building. Insisting on a certificate for it
    // would be insisting nobody runs their own model.
    for (const url of [
      "http://10.0.0.12:11434/v1",
      "http://192.168.1.50:8000/v1",
      "http://172.16.4.4:8080/v1",
      "http://workshop.internal:11434/v1",
    ]) {
      expect(isErr(make({ baseUrl: url })), url).toBe(false);
    }
  });

  it("refuses plain http to somewhere else, since a key would travel in the open", () => {
    expect(isErr(make({ baseUrl: "http://api.openai.com/v1" }))).toBe(true);
  });

  it("refuses something that is not an address at all", () => {
    expect(isErr(make({ baseUrl: "openai" }))).toBe(true);
  });

  it("needs one, for a kind that is reached over the wire", () => {
    expect(isErr(withNoAddress())).toBe(true);
  });

  it("needs none for the office's own built-in provider", () => {
    const service = unwrap(withNoAddress({ kind: "anthropic", name: "anthropic" }));

    expect(service.baseUrl).toBeNull();
  });
});

describe("how the service is paid for", () => {
  it("takes the name of a variable that holds the key", () => {
    expect(unwrap(make({ tokenEnv: "OPENAI_API_KEY" })).tokenEnv).toBe("OPENAI_API_KEY");
  });

  it("refuses something that is not a variable name", () => {
    expect(isErr(make({ tokenEnv: "my key" }))).toBe(true);
  });

  it("takes a reference to a key the office is keeping", () => {
    expect(unwrap(make({ secretRef: "vault://abc" })).secretRef).toBe("vault://abc");
  });

  it("refuses a reference that is not one, so nothing stores a key by accident", () => {
    // The whole point of the reference is that it is not the key.
    expect(isErr(make({ secretRef: "sk-live-abcdef" }))).toBe(true);
  });

  it("takes one way or the other, never both", () => {
    expect(isErr(make({ tokenEnv: "OPENAI_API_KEY", secretRef: "vault://abc" }))).toBe(true);
  });

  it("takes neither, which is a model running on your own machine", () => {
    const service = unwrap(make({ baseUrl: "http://localhost:11434/v1" }));

    expect(service.tokenEnv).toBeNull();
    expect(service.secretRef).toBeNull();
  });
});

describe("the models a service offers", () => {
  const withModels = (models: readonly unknown[]) => make({ models: models as never });

  it("names each one, which is what an employee asks for", () => {
    const service = unwrap(withModels([{ id: "gpt-5" }, { id: "gpt-5-mini" }]));

    expect(service.models.map((model) => model.id)).toEqual(["gpt-5", "gpt-5-mini"]);
  });

  it("refuses the same model twice", () => {
    expect(isErr(withModels([{ id: "gpt-5" }, { id: "gpt-5" }]))).toBe(true);
  });

  it("refuses one with no name", () => {
    expect(isErr(withModels([{ id: "  " }]))).toBe(true);
  });

  it("takes what it costs, which is the only way a model nobody knows gets priced", () => {
    const service = unwrap(
      withModels([{ id: "gpt-5", pricing: { inputPerMTok: 1.25, outputPerMTok: 10 } }]),
    );

    expect(service.models[0]?.pricing).toEqual({ inputPerMTok: 1.25, outputPerMTok: 10 });
  });

  it("takes a cache price too, since that is where the saving is", () => {
    const service = unwrap(
      withModels([
        { id: "gpt-5", pricing: { inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.12 } },
      ]),
    );

    expect(service.models[0]?.pricing?.cacheReadPerMTok).toBe(0.12);
  });

  it("refuses a price that is not a number, or is below nothing", () => {
    expect(
      isErr(withModels([{ id: "gpt-5", pricing: { inputPerMTok: -1, outputPerMTok: 1 } }])),
    ).toBe(true);
    expect(
      isErr(withModels([{ id: "gpt-5", pricing: { inputPerMTok: "cheap", outputPerMTok: 1 } }])),
    ).toBe(true);
  });

  it("refuses half a price, since a total from one is a figure nobody can trust", () => {
    expect(isErr(withModels([{ id: "gpt-5", pricing: { inputPerMTok: 1.25 } }]))).toBe(true);
  });

  it("takes what it can hold, and refuses a window that is not a count", () => {
    expect(
      unwrap(withModels([{ id: "gpt-5", contextWindow: 400_000 }])).models[0]?.contextWindow,
    ).toBe(400_000);
    expect(isErr(withModels([{ id: "gpt-5", contextWindow: 0 }]))).toBe(true);
    expect(isErr(withModels([{ id: "gpt-5", maxOutputTokens: -2 }]))).toBe(true);
  });
});

describe("changing a service that already exists", () => {
  const existing = (): LlmService => unwrap(make({ models: [{ id: "gpt-5" }] as never }));

  it("writes down what it was asked about, and leaves the rest", () => {
    const changed = unwrap(updateLlmService(existing(), { models: [{ id: "gpt-5-mini" }] }, []));

    expect(changed.models.map((model) => model.id)).toEqual(["gpt-5-mini"]);
    expect(changed.name).toBe("openai");
    expect(changed.createdAt).toEqual(at);
  });

  it("switches one off without forgetting it", () => {
    // Grants and employees name it; deleting it would lose all of that for an
    // afternoon's outage.
    expect(unwrap(updateLlmService(existing(), { enabled: false }, [])).enabled).toBe(false);
  });

  it("does not collide with itself when it keeps its own name", () => {
    expect(isErr(updateLlmService(existing(), { name: "openai" }, [{ name: "other" }]))).toBe(
      false,
    );
  });

  it("refuses a name another service already has", () => {
    expect(isErr(updateLlmService(existing(), { name: "other" }, [{ name: "other" }]))).toBe(true);
  });

  it("swaps a named variable for a kept key, rather than ending up with both", () => {
    const named = unwrap(make({ tokenEnv: "OPENAI_API_KEY" }));

    const changed = unwrap(updateLlmService(named, { secretRef: "vault://abc" }, []));

    expect(changed.secretRef).toBe("vault://abc");
    expect(changed.tokenEnv).toBeNull();
  });

  it("gives a key back, which is how a service stops costing anything", () => {
    const kept = unwrap(make({ secretRef: "vault://abc" }));

    expect(unwrap(updateLlmService(kept, { secretRef: null }, [])).secretRef).toBeNull();
  });
});

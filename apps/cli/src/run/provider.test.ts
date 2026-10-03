import { describe, expect, it } from "vitest";
import { createRunProvider } from "./provider.js";

describe("createRunProvider", () => {
  it("rehearses without calling anything when asked to", () => {
    expect(createRunProvider({ dryRun: true, apiKey: undefined }).id).toBe("anthropic");
  });

  it("builds a real provider when it has a key", () => {
    expect(createRunProvider({ dryRun: false, apiKey: "sk-test" }).id).toBe("anthropic");
  });
});

describe("an office that calls its own services", () => {
  it("runs without a key, because its employees may name nothing that needs one", () => {
    // `vo run office.yaml` against a model on this machine should need nothing
    // in the environment. Refusing to start would make the services block in
    // an office file useless.
    expect(() => createRunProvider({ dryRun: false, apiKey: undefined })).not.toThrow();
  });

  it("says plainly what is missing at the moment something does need it", async () => {
    const provider = createRunProvider({ dryRun: false, apiKey: undefined });

    await expect(provider.complete({ model: "claude-sonnet-5", messages: [] })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("still answers to the name the employees use, so the fallback is recognisable", () => {
    // The stand-in is `@vo/llm`'s, shared with the worker: two copies of "what
    // to do when there is no key" is how the two of them come to disagree.
    expect(createRunProvider({ dryRun: false, apiKey: undefined }).id).toBe("anthropic");
  });

  it("refuses a stream too, rather than ending it quietly", async () => {
    const provider = createRunProvider({ dryRun: false, apiKey: undefined });

    const drain = async (): Promise<void> => {
      for await (const _event of provider.stream({ model: "claude-sonnet-5", messages: [] })) {
        // drained
      }
    };

    await expect(drain()).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

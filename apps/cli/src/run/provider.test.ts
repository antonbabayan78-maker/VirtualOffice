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
});

import { describe, expect, it } from "vitest";
import { createRunProvider } from "./provider.js";

describe("createRunProvider", () => {
  it("rehearses without calling anything when asked to", () => {
    expect(createRunProvider({ dryRun: true, apiKey: undefined }).id).toBe("anthropic");
  });

  it("says plainly what is missing when there is no key", () => {
    expect(() => createRunProvider({ dryRun: false, apiKey: undefined })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("builds a real provider when it has a key", () => {
    expect(createRunProvider({ dryRun: false, apiKey: "sk-test" }).id).toBe("anthropic");
  });
});

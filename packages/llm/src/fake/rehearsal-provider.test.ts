import { describe, expect, it } from "vitest";
import { rehearsalProvider } from "./rehearsal-provider.js";
import type { CompletionRequest } from "../provider/types.js";

const ask = (tools: string[]): CompletionRequest => ({
  model: "claude-sonnet-5",
  messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
  tools: tools.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
});

describe("rehearsalProvider", () => {
  it("submits work when asked to work", async () => {
    const response = await rehearsalProvider().complete(ask(["submit_work"]));
    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "submit_work" });
  });

  it("approves when asked to review, so a rehearsal reaches the end", async () => {
    const response = await rehearsalProvider().complete(ask(["review_verdict"]));
    const block = response.content[0];
    expect(block).toMatchObject({ type: "tool_use", name: "review_verdict" });
    if (block?.type === "tool_use") expect(block.input).toMatchObject({ approved: true });
  });

  it("answers as the office's own provider id, so costs are priced", () => {
    expect(rehearsalProvider().id).toBe("anthropic");
  });
});

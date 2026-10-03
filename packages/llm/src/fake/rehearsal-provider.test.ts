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

describe("rehearsing an office that has a definition of done", () => {
  const withCriteria = (tools: string[], criteria: string[]): CompletionRequest => ({
    ...ask(tools),
    system: [{ text: `This work is done when: ${criteria.join(" | ")}`, cache: false }],
  });

  it("answers the list it was given, so a rehearsal is not sent back forever", async () => {
    const criteria = ["handles malformed input", "has tests"];
    const response = await rehearsalProvider().complete(withCriteria(["review_verdict"], criteria));
    const block = response.content[0];
    if (block?.type === "tool_use") expect(block.input).toMatchObject({ met: criteria });
    else throw new Error("expected a verdict");
  });

  it("answers the list when doing the work as well", async () => {
    const criteria = ["handles malformed input"];
    const response = await rehearsalProvider().complete(withCriteria(["submit_work"], criteria));
    const block = response.content[0];
    if (block?.type === "tool_use") expect(block.input).toMatchObject({ met: criteria });
    else throw new Error("expected a submission");
  });

  it("claims nothing when no list was given", async () => {
    const response = await rehearsalProvider().complete(ask(["review_verdict"]));
    const block = response.content[0];
    if (block?.type === "tool_use") expect(block.input).toMatchObject({ met: [] });
  });
});

describe("rehearsing a shootout", () => {
  it("decides it, so a rehearsal does not leave a contest open forever", async () => {
    const response = await rehearsalProvider().complete(ask(["shootout_verdict"]));
    const block = response.content[0];

    expect(block).toMatchObject({ type: "tool_use", name: "shootout_verdict" });
    if (block?.type === "tool_use") {
      expect(block.input).toMatchObject({ winner: "A" });
      expect(typeof block.input["reason"]).toBe("string");
    }
  });

  it("picks the first answer, which is the one label a contest always has", async () => {
    // It cannot read the answers and has no opinion: favourable and arbitrary,
    // which is what every other answer this provider gives is.
    const response = await rehearsalProvider().complete(ask(["shootout_verdict"]));
    const block = response.content[0];
    if (block?.type === "tool_use") expect(block.input["winner"]).toBe("A");
  });
});

describe("rehearsing an office that was granted tools", () => {
  /** A prompt shaped the way a lazy toolset writes one: an index, and find_tool. */
  const withCatalogue = (
    lines: readonly string[],
    tools: string[] = ["find_tool", "submit_work"],
  ): CompletionRequest => ({
    ...ask(tools),
    system: [{ text: `Tools you can ask for:\n${lines.join("\n")}`, cache: false }],
  });

  it("asks for a tool it was told about, rather than submitting untried work", async () => {
    // A rehearsal that never calls a tool cannot rehearse an office with tools:
    // the grants, the broker, the server behind it and the gate in front of it
    // are all untested until something asks.
    const response = await rehearsalProvider().complete(
      withCatalogue(["post__send_email (conn-post): Send an email."]),
    );

    const block = response.content[0];
    expect(block).toMatchObject({ type: "tool_use", name: "find_tool" });
    if (block?.type === "tool_use") {
      expect(block.input).toMatchObject({ query: "post__send_email" });
    }
  });

  it("calls the tool once it has been handed it", async () => {
    const response = await rehearsalProvider().complete(
      withCatalogue(
        ["post__send_email (conn-post): Send an email."],
        ["find_tool", "post__send_email", "submit_work"],
      ),
    );

    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "post__send_email" });
  });

  it("submits once this run has called it, read from the conversation", async () => {
    const request = withCatalogue(
      ["post__send_email (conn-post): Send an email."],
      ["find_tool", "post__send_email", "submit_work"],
    );
    const answered: CompletionRequest = {
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "post__send_email", input: {} }],
        },
        { role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: "sent" }] },
      ],
    };

    const response = await rehearsalProvider().complete(answered);

    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "submit_work" });
  });

  it("tries again for the next piece of work, not once per process", async () => {
    // A worker builds one provider and uses it for every job it ever does. A
    // flag kept in the provider would mean the first task of the day tried a
    // tool and none of the others did — which is what happened the first time
    // this ran against a real office.
    const provider = rehearsalProvider();
    const request = withCatalogue(
      ["post__send_email (conn-post): Send an email."],
      ["find_tool", "post__send_email", "submit_work"],
    );

    await provider.complete(request);
    const nextJob = await provider.complete(request);

    expect(nextJob.content[0]).toMatchObject({ type: "tool_use", name: "post__send_email" });
  });

  it("leaves the office's own filing tool alone, which is not what it is proving", async () => {
    const response = await rehearsalProvider().complete(
      withCatalogue([], ["file_document", "submit_work"]),
    );

    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "submit_work" });
  });

  it("submits as before in an office that granted nothing", async () => {
    const response = await rehearsalProvider().complete(ask(["submit_work"]));

    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "submit_work" });
  });

  it("does not reach for a tool while reviewing somebody else's work", async () => {
    const response = await rehearsalProvider().complete(
      withCatalogue(
        ["post__send_email (conn-post): Send an email."],
        ["find_tool", "review_verdict"],
      ),
    );

    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "review_verdict" });
  });
});

describe("rehearsing an office whose people have been told things", () => {
  /** What a prompt looks like once somebody's standing instructions are in it. */
  const taught = (said: string, after: string[] = []): CompletionRequest => ({
    ...ask(["review_verdict"]),
    system: [
      { text: `You are Ada, Clerk.\nHow you work:\n${said}`, cache: true },
      ...after.map((text) => ({ text, cache: false })),
    ],
  });

  it("answers the office's criteria, not a sentence that reads like them", async () => {
    // An owner writing "This work is done when: the customer replies" into
    // somebody's instructions would otherwise have a rehearsal report criteria
    // the office never set — a lie in the record of what was checked.
    const response = await rehearsalProvider().complete(
      taught("This work is done when: the customer is happy.", [
        "This work is done when: handles malformed input | has tests",
      ]),
    );

    const block = response.content[0];
    if (block?.type !== "tool_use") throw new Error("expected a verdict");
    expect(block.input).toMatchObject({ met: ["handles malformed input", "has tests"] });
  });

  it("does not reach for a tool because somebody's prose mentions one", async () => {
    // The index lines are `name (connectorId): description`. A paragraph that
    // names a tool in passing is not an index.
    const response = await rehearsalProvider().complete({
      ...ask(["find_tool", "submit_work"]),
      system: [
        {
          text:
            "You are Ada, Clerk.\nHow you work:\n" +
            "post__send_email (the mail server our team uses): only with a person's say-so.",
          cache: true,
        },
      ],
    });

    expect(response.content[0]).toMatchObject({ type: "tool_use", name: "submit_work" });
  });
});
